import { createHash } from "node:crypto";
import type { AbortableSemaphore } from "../shared/semaphore.js";
import type { ShellResult, WorkflowHostPolicy } from "./backend.js";
import { MAX_WORKFLOW_ID, type WorkflowLimitsV1 } from "./protocol.js";
import { MAX_FRAME_BYTES } from "./worker-protocol.js";

export const DEFAULT_WORKFLOW_LIMITS = {
    maxConcurrency: 4,
    maxAgents: 1_000,
    timeoutMs: 10 * 60_000,
    maxTokens: 0,
    maxCost: 0,
} as const;
export const MAX_AGENT_PROMPT_BYTES = 8_000;
export const MAX_SHELL_OUTPUT_BYTES = 128 * 1024;

/** Serialize a workflow value, enforcing the RPC frame budget. Returns the JSON text. */
export function boundedJson(value: unknown): string {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Workflow values must be JSON serializable.");
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("Workflow RPC value exceeds the 256 KiB limit.");
    return text;
}

/** Durable operation identity: stable across hosts and runtimes while remaining bounded by the protocol. */
export function workflowOperationId(kind: "shell" | "agent", identity: unknown): string {
    if (typeof identity !== "string" || identity.length > 1024 || !identity.includes("#"))
        throw new Error("Invalid workflow operation identity.");
    return `${kind}-${createHash("sha256").update(identity).digest("hex")}`.slice(0, MAX_WORKFLOW_ID);
}

export function validateSchema(schema: unknown, depth = 0, state = { nodes: 0, properties: 0 }): void {
    if (depth > 16 || ++state.nodes > 1_000) throw new Error("Agent schema exceeds complexity limits.");
    if (schema === null || typeof schema === "string" || typeof schema === "boolean" || typeof schema === "number")
        return;
    if (Array.isArray(schema)) {
        for (const value of schema) validateSchema(value, depth + 1, state);
        return;
    }
    if (!schema || typeof schema !== "object") throw new Error("Agent schema must be JSON-compatible.");
    for (const [key, value] of Object.entries(schema)) {
        if (++state.properties > 2_000 || key.length > 512) throw new Error("Agent schema exceeds property limits.");
        validateSchema(value, depth + 1, state);
    }
}

export function schemaValid(value: unknown, schema: unknown): boolean {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
    const s = schema as Record<string, unknown>;
    if (s.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const o = value as Record<string, unknown>;
        if (Array.isArray(s.required) && !s.required.every((k) => typeof k === "string" && k in o)) return false;
        if (s.properties && typeof s.properties === "object")
            for (const [k, child] of Object.entries(s.properties))
                if (k in o && !schemaValid(o[k], child)) return false;
    } else if (s.type === "array") return Array.isArray(value) && value.every((v) => schemaValid(v, s.items));
    else if (s.type === "string") return typeof value === "string";
    else if (s.type === "number") return typeof value === "number";
    else if (s.type === "boolean") return typeof value === "boolean";
    return true;
}

const clampTimeout = (requested: unknown) =>
    Math.min(DEFAULT_WORKFLOW_LIMITS.timeoutMs, Math.max(1, Number(requested) || DEFAULT_WORKFLOW_LIMITS.timeoutMs));

export function validateLaunchMetadata(input: { name: unknown; sessionId: unknown; cwd: unknown }): void {
    if (
        typeof input.name !== "string" ||
        !input.name ||
        input.name.length > 512 ||
        typeof input.sessionId !== "string" ||
        !input.sessionId ||
        input.sessionId.length > 256 ||
        typeof input.cwd !== "string" ||
        !input.cwd ||
        input.cwd.length > 4_000
    )
        throw new Error("Invalid workflow launch metadata.");
}

export function normalizeWorkflowLimits(requested: Partial<WorkflowLimitsV1>): WorkflowLimitsV1 {
    for (const [key, value] of Object.entries(requested))
        if (
            !["maxConcurrency", "maxAgents", "timeoutMs", "maxTokens", "maxCost"].includes(key) ||
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0
        )
            throw new Error("Invalid workflow limits.");
    return {
        maxConcurrency: Math.min(
            16,
            Math.max(1, Math.floor(requested.maxConcurrency ?? DEFAULT_WORKFLOW_LIMITS.maxConcurrency)),
        ),
        maxAgents: Math.min(1_000, Math.max(1, Math.floor(requested.maxAgents ?? DEFAULT_WORKFLOW_LIMITS.maxAgents))),
        timeoutMs: Math.min(
            DEFAULT_WORKFLOW_LIMITS.timeoutMs,
            Math.max(1, requested.timeoutMs ?? DEFAULT_WORKFLOW_LIMITS.timeoutMs),
        ),
        maxTokens: requested.maxTokens ?? 0,
        maxCost: requested.maxCost ?? 0,
    };
}

export interface ShellRequestV1 {
    command: string;
    env?: Record<string, string>;
    timeoutMs: number;
}

export function validateShellRequest(value: unknown): ShellRequestV1 {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shell request.");
    const request = value as Record<string, unknown>,
        command = request.command,
        rawOptions = request.options;
    if (
        Object.keys(request).some((key) => !["command", "options"].includes(key)) ||
        typeof command !== "string" ||
        !command.trim() ||
        Buffer.byteLength(command) > 8_000 ||
        !rawOptions ||
        typeof rawOptions !== "object" ||
        Array.isArray(rawOptions)
    )
        throw new Error("Invalid shell request.");
    const opts = rawOptions as Record<string, unknown>;
    if (
        Object.keys(opts).some((key) => !["timeoutMs", "env"].includes(key)) ||
        (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || (opts.timeoutMs as number) <= 0)) ||
        (opts.env !== undefined && (!opts.env || typeof opts.env !== "object" || Array.isArray(opts.env)))
    )
        throw new Error("Invalid or unknown shell option.");
    let env: Record<string, string> | undefined;
    if (opts.env !== undefined) {
        const entries = Object.entries(opts.env as Record<string, unknown>);
        if (
            entries.length > 128 ||
            entries.some(
                ([key, item]) =>
                    !key ||
                    key.length > 256 ||
                    key.includes("=") ||
                    key.includes("\0") ||
                    typeof item !== "string" ||
                    Buffer.byteLength(item) > 8_000,
            )
        )
            throw new Error("Invalid shell environment override.");
        env = Object.fromEntries(entries) as Record<string, string>;
    }
    boundedJson(opts);
    return { command, env, timeoutMs: clampTimeout(opts.timeoutMs) };
}

export function validateShellResult(result: Awaited<ShellResult>): ShellResult {
    if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).some((key) => !["exitCode", "stdout", "stderr"].includes(key)) ||
        !Number.isInteger(result.exitCode) ||
        result.exitCode < 0 ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_SHELL_OUTPUT_BYTES
    )
        throw new Error("Shell executor returned an invalid or oversized result.");
    return result;
}

export interface AgentRequestV1 {
    prompt: string;
    label: string;
    role: string;
    model?: string;
    schema?: Record<string, unknown>;
    isolation?: "worktree";
    retries: number;
    timeoutMs: number;
    writeCapable: boolean;
}

export function validateAgentRequest(
    value: unknown,
    context: { policy?: WorkflowHostPolicy; activeSharedWriters: number },
): AgentRequestV1 {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent request payload.");
    const request = value as Record<string, unknown>,
        prompt = request.prompt,
        rawOptions = request.options;
    if (typeof prompt !== "string") throw new Error("Agent prompt must be a string.");
    if (!prompt.trim()) throw new Error("Agent prompt must not be empty.");
    const promptBytes = Buffer.byteLength(prompt);
    if (promptBytes > MAX_AGENT_PROMPT_BYTES)
        throw new Error(
            `Agent prompt exceeds the ${MAX_AGENT_PROMPT_BYTES.toLocaleString("en-US")}-byte limit (received ${promptBytes.toLocaleString("en-US")} bytes).`,
        );
    if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions))
        throw new Error("Agent options must be an object.");
    const opts = rawOptions as Record<string, unknown>;
    if (
        Object.keys(opts).some(
            (key) => !["label", "role", "model", "schema", "retries", "timeoutMs", "isolation"].includes(key),
        ) ||
        (opts.label !== undefined && (typeof opts.label !== "string" || opts.label.length > 512)) ||
        (opts.role !== undefined && (typeof opts.role !== "string" || !opts.role || opts.role.length > 128)) ||
        (opts.model !== undefined && (typeof opts.model !== "string" || !opts.model || opts.model.length > 256)) ||
        (opts.schema !== undefined &&
            (!opts.schema || typeof opts.schema !== "object" || Array.isArray(opts.schema))) ||
        (opts.retries !== undefined && (!Number.isInteger(opts.retries) || (opts.retries as number) < 0)) ||
        (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || (opts.timeoutMs as number) <= 0))
    )
        throw new Error("Invalid or unknown agent option.");
    boundedJson(opts);
    if (opts.schema !== undefined) validateSchema(opts.schema);
    const role = typeof opts.role === "string" ? opts.role : "generic",
        isolation = opts.isolation,
        schema = opts.schema as Record<string, unknown> | undefined;
    if (isolation !== undefined && isolation !== "worktree")
        throw new Error(`Unknown agent isolation: ${String(isolation)}`);
    const writeCapable = role !== "explore" && role !== "read-only";
    if (
        writeCapable &&
        isolation !== "worktree" &&
        context.activeSharedWriters > 0 &&
        !context.policy?.allowUnsafeSharedCheckout
    )
        throw new Error("Concurrent write-capable agents require worktree isolation.");
    if (context.policy?.roles && !context.policy.roles.includes(role))
        throw new Error(`Agent role is not allowed by host policy: ${role}`);
    const model =
        context.policy?.resolveModel?.(role, typeof opts.model === "string" ? opts.model : undefined) ??
        (typeof opts.model === "string" ? opts.model : undefined);
    if (model && context.policy?.models && !context.policy.models.includes(model))
        throw new Error(`Agent model is not allowed by host policy: ${model}`);
    return {
        prompt,
        label: String(opts.label || prompt).slice(0, 512),
        role,
        model,
        schema,
        isolation,
        retries: Math.min(3, Math.max(0, Number(opts.retries) || 0)),
        timeoutMs: clampTimeout(opts.timeoutMs),
        writeCapable,
    };
}

/** The slice of an active run a durable operation needs. */
export interface DurableOperationRun {
    controller: AbortController;
    semaphore: AbortableSemaphore;
    cooperativeTasks: Set<Promise<unknown>>;
    completions: Map<string, unknown>;
}

export interface DurableOperation<T> {
    run: DurableOperationRun;
    operationId: string;
    timeoutMs: number;
    timeoutMessage: string;
    /** Register the in-flight executor promise so shutdown can await it with a grace period. */
    cooperative: boolean;
    now: () => number;
    /** Runs after the semaphore slot is acquired, before the timeout starts. */
    beforeExecute?: () => Promise<void>;
    /** Runs inside the timeout scope, before the executor starts (e.g. worktree setup). */
    setup?: () => Promise<void>;
    execute: (signal: AbortSignal) => Promise<T>;
    /** Validates and bounds the raced result; returns the durable value. */
    validateResult: (result: T) => unknown;
    /** Journals the durable value before it enters the completion cache. */
    journal?: (value: unknown, at: number) => Promise<void>;
    /** Runs after the value is durable and cached, before cleanup. */
    onSuccess?: (value: unknown) => void;
    /** Runs after the timeout is cleared, success or failure (e.g. worktree cleanup). */
    cleanup?: () => Promise<void>;
    /** Runs last, before the semaphore slot is released, with the failure if the operation failed. */
    onSettled?: (failure?: { error: unknown }) => void;
}

/**
 * The one durable-operation pipeline behind workflow shell and agent RPCs:
 * semaphore → timeout race → result validation → journal → completion cache.
 * Replay short-circuiting happens in the caller before any of this starts.
 */
export async function runDurableOperation<T>(op: DurableOperation<T>): Promise<unknown> {
    const release = await op.run.semaphore.acquire(op.run.controller.signal);
    let failure: { error: unknown } | undefined;
    try {
        await op.beforeExecute?.();
        const controller = new AbortController(),
            signal = AbortSignal.any([op.run.controller.signal, controller.signal]);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error(op.timeoutMessage));
            }, op.timeoutMs);
        });
        try {
            await op.setup?.();
            const operation = Promise.resolve(op.execute(signal));
            if (op.cooperative) {
                op.run.cooperativeTasks.add(operation);
                operation.finally(() => op.run.cooperativeTasks.delete(operation)).catch(() => {});
            }
            const result = await Promise.race([operation, timeout]);
            const value = op.validateResult(result);
            await op.journal?.(value, op.now());
            op.run.completions.set(op.operationId, structuredClone(value));
            op.onSuccess?.(value);
            return value;
        } finally {
            if (timer) clearTimeout(timer);
            await op.cleanup?.();
        }
    } catch (error) {
        failure = { error };
        throw error;
    } finally {
        op.onSettled?.(failure);
        release();
    }
}
