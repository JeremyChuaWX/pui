import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AbortableSemaphore } from "../subagent/semaphore.js";
import { maskLiterals } from "./js-scan.js";
import type {
    WorkflowActivityV1,
    WorkflowAgentSummaryV1,
    WorkflowEntrypoint,
    WorkflowLimitsV1,
    WorkflowRunSummaryV1,
    WorkflowUsageV1,
} from "./protocol.js";
import {
    boundedJson,
    DEFAULT_WORKFLOW_LIMITS,
    MAX_SHELL_OUTPUT_BYTES,
    normalizeWorkflowLimits,
    runDurableOperation,
    schemaValid,
    validateAgentRequest,
    validateLaunchMetadata,
    validateShellRequest,
    validateShellResult,
    workflowOperationId,
} from "./rpc-operations.js";
import type { ImmutableRunLaunch, StoredRun } from "./run-storage.js";
import { executableWorkflowScript } from "./source.js";
import { parseWorkerFrame, WorkerFrameDecoder } from "./worker-protocol.js";
import { WORKER_SOURCE } from "./worker-source.js";
import { type OwnedWorktree, WorkflowWorktreeManager } from "./worktree.js";

export { DEFAULT_WORKFLOW_LIMITS };

const MAX_SCRIPT_BYTES = 64 * 1024,
    STDERR_BYTES = 8 * 1024;
const READY_TIMEOUT_MS = 5_000,
    HEARTBEAT_TIMEOUT_MS = 5_000,
    LARGE_RUN_WARNING_AGENTS = 25,
    MAX_SHELL_INVOCATIONS = 1_000;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const INTERRUPTION_WARNING = "Workflow interrupted by host shutdown; resume after restart.";

export interface AgentRequest {
    prompt: string;
    role: string;
    model?: string;
    schema?: Record<string, unknown>;
    signal: AbortSignal;
    timeoutMs: number;
    cwd: string;
}
export interface AgentResult {
    value: unknown;
    usage?: Partial<WorkflowUsageV1>;
}
export type AgentExecutor = (request: AgentRequest) => Promise<AgentResult>;
export interface ShellRequest {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
}
export interface ShellResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export type ShellExecutor = (request: ShellRequest) => Promise<ShellResult>;

export interface WorkflowLaunch {
    name: string;
    script: string;
    /** Script bodies are the compatibility default; workflow files use an exported function. */
    entrypoint?: WorkflowEntrypoint;
    args?: unknown;
    sessionId: string;
    cwd: string;
    limits?: Partial<WorkflowLimitsV1>;
    parentRunId?: string;
    /** Internal replay seed, journaled before the new run executes. */
    seedCompletions?: ReadonlyMap<string, unknown>;
}
export interface WorkflowHostPolicy {
    roles?: readonly string[];
    allowUnsafeSharedCheckout?: boolean;
    models?: readonly string[];
    resolveModel?: (role: string, requested?: string) => string | undefined;
}
/**
 * Host facilities and supervision timings with production defaults; tests inject overrides here
 * instead of widening the public options.
 */
export interface WorkflowPlatform {
    now: () => number;
    uuid: () => string;
    /** Diagnostics sink for persistence and shutdown failures. */
    log: (message: string) => void;
    /**
     * Trusted worker module source. Never accept untrusted input here. An injected module receives
     * the same read-only worker-file permission, 128 MiB heap cap, empty environment, and no
     * filesystem-write, network, or child-process permissions.
     */
    workerSource: string;
    /** Worker startup deadline. */
    readyTimeoutMs: number;
    /** Worker heartbeat deadline once ready. */
    watchdogMs: number;
    /** Overrides every run's limit-derived total timeout when set. */
    runTimeoutMs?: number;
    shutdownGraceMs: number;
}
/** The durable-run store the backend requires; WorkflowRunStorage is the production implementation. */
export interface WorkflowRunStore {
    readonly root: string;
    create(cwd: string, id: string, launch: ImmutableRunLaunch, snapshot: WorkflowRunSummaryV1): Promise<string>;
    snapshot(directory: string, snapshot: WorkflowRunSummaryV1): Promise<void>;
    complete(directory: string, operation: string, value: unknown, at?: number): Promise<void>;
    worktree(directory: string, operation: string, owned: OwnedWorktree | null, at?: number): Promise<void>;
    terminal(directory: string, result: unknown, summary: WorkflowRunSummaryV1): Promise<void>;
    claimDelivery(directory: string): Promise<boolean>;
    recoverDeliveryClaim(directory: string, staleAfterMs?: number): Promise<boolean>;
    markDelivered(directory: string): Promise<void>;
    releaseClaim(directory: string): Promise<void>;
    discover(cwd: string): Promise<StoredRun[]>;
}
export interface WorkflowBackendOptions {
    agentExecutor: AgentExecutor;
    /** Trusted host command runner. Defaults to the platform shell in the workflow cwd. */
    shellExecutor?: ShellExecutor;
    nodePath?: string;
    environment?: NodeJS.ProcessEnv;
    eventSink?: (run: WorkflowRunSummaryV1) => void;
    policy?: WorkflowHostPolicy;
    /** True for executors (such as runSubagent) that honor abort and reap their child process. */
    cooperativeExecutor?: boolean;
    storage?: WorkflowRunStore;
    worktreeManager?: WorkflowWorktreeManager;
    platform?: Partial<WorkflowPlatform>;
}
export interface WorkflowBackend {
    launch(input: WorkflowLaunch, signal?: AbortSignal): Promise<{ runId: string }>;
    initialize?(cwd: string): Promise<WorkflowRunSummaryV1[]>;
    recover?(id: string): Promise<void>;
    list(): WorkflowRunSummaryV1[];
    inspect(id: string): { run: WorkflowRunSummaryV1; script: string; result?: string };
    subscribe(listener: (run: WorkflowRunSummaryV1) => void): () => void;
    control(
        id: string,
        control:
            | "pause"
            | "resume"
            | "stop"
            | "restart-agent"
            | "retry"
            | { action: "pause" | "resume" | "stop" | "restart-agent" | "retry"; agentId?: string },
    ): Promise<{ runId?: string } | undefined>;
    claimTerminalDelivery?(id: string, options?: { recovery?: boolean }): Promise<boolean>;
    markTerminalDelivered?(id: string): Promise<void>;
    releaseTerminalDelivery?(id: string): Promise<void>;
    shutdown(): Promise<void>;
}
interface ActiveRun {
    summary: WorkflowRunSummaryV1;
    script: string;
    controller: AbortController;
    child?: ReturnType<typeof spawn>;
    result?: string;
    settlement: Promise<void>;
    cooperativeTasks: Set<Promise<unknown>>;
    directory?: string;
    completions: Map<string, unknown>;
    paused: boolean;
    resumeWaiters: (() => void)[];
    persistence: Promise<void>;
    input: WorkflowLaunch;
    semaphore: AbortableSemaphore;
    activeSharedWriters: number;
    interrupted?: boolean;
    stopping?: boolean;
}

const emptyUsage = (): WorkflowUsageV1 => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
});
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const addUsage = (target: WorkflowUsageV1, value: Partial<WorkflowUsageV1> = {}) => {
    for (const key of Object.keys(target) as (keyof WorkflowUsageV1)[]) target[key] += Number(value[key]) || 0;
};

function eraseTypeOnlyNamespaces(source: string): string {
    const code = maskLiterals(source, { preserveTemplateInterpolations: true }),
        output = [...source];
    for (const match of code.matchAll(/\bnamespace\s+[A-Za-z_$][\w$]*\s*\{/g)) {
        const start = match.index,
            open = start + match[0].lastIndexOf("{");
        let depth = 1,
            end = open + 1;
        while (end < code.length && depth) {
            if (code[end] === "{") depth++;
            else if (code[end] === "}") depth--;
            end++;
        }
        if (depth || new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)).trim())
            throw new Error("Workflow script uses TypeScript syntax unsupported in strip-only mode.");
        for (let index = start; index < end; index++)
            if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
    return output.join("");
}

export function preflightWorkflow(
    script: string,
    entrypoint: WorkflowEntrypoint = "script",
): { phases: string[]; agents: number; shells: number } {
    if (!script.trim()) throw new Error("Workflow script must not be empty.");
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error("Workflow script exceeds the 64 KiB limit.");
    if (entrypoint !== "script" && entrypoint !== "function") throw new Error("Invalid workflow entrypoint.");
    const executable = executableWorkflowScript(script, entrypoint),
        erasableExecutable = eraseTypeOnlyNamespaces(executable);
    // Node executes workflows with strip-only type erasure, so reject syntax Bun would otherwise transform.
    const sourceCode = maskLiterals(executable, { preserveTemplateInterpolations: true });
    if (
        /\benum\s+[A-Za-z_$]/.test(sourceCode) ||
        /\bmodule\s+[A-Za-z_$]/.test(sourceCode) ||
        /@[A-Za-z_$]/.test(sourceCode) ||
        /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?[#A-Za-z_$]/.test(sourceCode)
    )
        throw new Error("Workflow script uses TypeScript syntax unsupported in strip-only mode.");
    // Defense in depth only: process isolation, Node permissions, a stripped realm, and host validation
    // remain authoritative. Reject obvious and obfuscated ambient-authority probes before approval.
    const forbidden =
        /(?:\b(?:process|require|eval|Function|WebSocket|fetch|XMLHttpRequest|Deno|Bun|child_process)\b|\bimport\b|\bexport\s|__proto__)/;
    // Match the worker's type erasure before scanning; Bun hosts cannot import Node's stripTypeScriptTypes.
    const code = maskLiterals(
        new Bun.Transpiler({ loader: "ts" }).transformSync(`(async()=>{${erasableExecutable}\n})()`),
        {
            preserveTemplateInterpolations: true,
        },
    );
    if (forbidden.test(code)) throw new Error("Workflow script uses a forbidden runtime capability.");
    return {
        phases: [...executable.matchAll(/\bphase\s*\(\s*(["'`])([^"'`]{1,512})\1/g)]
            .map((m) => m[2] ?? "")
            .slice(0, 100),
        agents: [...executable.matchAll(/\bagent\s*\(/g)].length,
        shells: [...executable.matchAll(/\bshell\s*\(/g)].length,
    };
}
async function commandVersion(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const windowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
            executable = windowsScript ? (environment.ComSpec ?? "cmd.exe") : command,
            args = windowsScript ? ["/d", "/s", "/c", `"${command}" --version`] : ["--version"],
            child = spawn(executable, args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: environment,
                windowsHide: true,
            });
        let output = "",
            settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve(output.trim());
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("version probe timed out"));
        }, 2_000);
        child.stdout.on("data", (c) => {
            output = `${output}${c}`.slice(0, 1024);
        });
        child.once("error", (e) => finish(e));
        child.once("close", (code) => finish(code === 0 ? undefined : new Error(`exit code ${code}`)));
    });
}
export async function resolveWorkflowNode(
    options: { environment?: NodeJS.ProcessEnv; configuredPath?: string } = {},
): Promise<string> {
    const env = options.environment ?? process.env,
        failures: string[] = [];
    for (const [source, candidate] of [
        ["PUI_WORKFLOW_NODE", env.PUI_WORKFLOW_NODE],
        ["configured path", options.configuredPath],
        ["PATH", "node"],
    ] as const) {
        if (!candidate) continue;
        try {
            const version = await commandVersion(candidate, env),
                match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
            if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19))
                throw new Error(`found ${version}; need >=22.19.0`);
            if (candidate.includes(path.sep)) return await realpath(candidate);
            const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
            for (const directory of (env.PATH ?? "").split(path.delimiter))
                for (const extension of extensions) {
                    const located = path.join(directory || ".", `${candidate}${extension}`);
                    try {
                        await fs.promises.access(located, fs.constants.X_OK);
                        return await realpath(located);
                    } catch {}
                }
            return candidate;
        } catch (e) {
            failures.push(`${source} (${candidate}): ${errorMessage(e)}`);
        }
    }
    throw new Error(
        `Workflows require an external Node >=22.19. Set PUI_WORKFLOW_NODE. Attempts: ${failures.join("; ") || "none"}`,
    );
}

function runWorkflowShell(request: ShellRequest, environment: NodeJS.ProcessEnv): Promise<ShellResult> {
    if (request.signal.aborted) return Promise.reject(new Error("Shell command was cancelled."));
    return new Promise((resolve, reject) => {
        const child = spawn(request.command, {
            cwd: request.cwd,
            env: { ...environment, ...request.env },
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
        });
        let stdout = "",
            stderr = "",
            settled = false,
            closed = false,
            terminationReason: "cancelled" | "timed_out" | "output" | undefined,
            killTimer: NodeJS.Timeout | undefined,
            spawnError: Error | undefined;
        const sendSignal = (signal: NodeJS.Signals) => {
            if (closed) return;
            try {
                process.platform !== "win32" && child.pid ? process.kill(-child.pid, signal) : child.kill(signal);
            } catch {}
        };
        const terminate = (reason: NonNullable<typeof terminationReason>) => {
            if (terminationReason || closed) return;
            terminationReason = reason;
            sendSignal("SIGTERM");
            killTimer = setTimeout(() => sendSignal("SIGKILL"), 500);
            killTimer.unref();
        };
        const finish = (error?: Error, result?: ShellResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            request.signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else if (result) resolve(result);
            else reject(new Error("Shell command returned no result."));
        };
        const abort = () => terminate("cancelled");
        const append = (stream: "stdout" | "stderr", chunk: string) => {
            if (terminationReason === "output") return;
            if (stream === "stdout") stdout += chunk;
            else stderr += chunk;
            if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_SHELL_OUTPUT_BYTES) terminate("output");
        };
        const timer = setTimeout(() => terminate("timed_out"), request.timeoutMs);
        request.signal.addEventListener("abort", abort, { once: true });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
        child.once("error", (error) => {
            spawnError = error;
        });
        child.once("close", (code) => {
            // The platform shell can exit while one of its descendants ignores SIGTERM.
            if (terminationReason) sendSignal("SIGKILL");
            closed = true;
            if (spawnError) finish(spawnError);
            else if (terminationReason === "cancelled") finish(new Error("Shell command was cancelled."));
            else if (terminationReason === "timed_out") finish(new Error("Shell command timed out."));
            else if (terminationReason === "output")
                finish(new Error(`Shell command output exceeds the ${MAX_SHELL_OUTPUT_BYTES / 1024} KiB limit.`));
            else finish(undefined, { exitCode: code ?? 1, stdout, stderr });
        });
        if (request.signal.aborted) abort();
    });
}

export function createWorkflowBackend(options: WorkflowBackendOptions): WorkflowBackend {
    const home = fs.realpathSync(os.homedir()),
        worktreeBase = options.storage
            ? path.join(path.dirname(options.storage.root), "workflow-worktrees")
            : path.join(home, ".pi", "agent", "workflow-worktrees"),
        relativeToHome = path.relative(home, worktreeBase),
        runs = new Map<string, ActiveRun>(),
        listeners = new Set<(run: WorkflowRunSummaryV1) => void>(),
        worktrees =
            options.worktreeManager ??
            new WorkflowWorktreeManager(worktreeBase, {
                trustedBoundary:
                    relativeToHome === "" || (!relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome))
                        ? home
                        : undefined,
            }),
        shellExecutor =
            options.shellExecutor ??
            ((request: ShellRequest) => runWorkflowShell(request, options.environment ?? process.env));
    let shuttingDown = false,
        pendingLaunches = 0,
        pendingLaunchWaiter: (() => void) | undefined;
    const platform: WorkflowPlatform = {
        now: Date.now,
        uuid: () => crypto.randomUUID(),
        log: (message) => console.error(message),
        workerSource: WORKER_SOURCE,
        readyTimeoutMs: READY_TIMEOUT_MS,
        watchdogMs: HEARTBEAT_TIMEOUT_MS,
        shutdownGraceMs: 2_000,
        ...options.platform,
    };
    const now = platform.now;
    const persist = (a: ActiveRun, write: () => Promise<void>) => (a.persistence = a.persistence.then(write, write));
    const emit = (copy: WorkflowRunSummaryV1) => {
        options.eventSink?.(copy);
        for (const listener of listeners) listener(copy);
    };
    const publish = (a: ActiveRun) => {
        // Shutdown owns the final recoverable snapshot; late RPC cleanup must not replace it.
        if (a.interrupted) return;
        a.summary.updatedAt = now();
        const copy = structuredClone(a.summary);
        emit(copy);
        const directory = a.directory;
        const storage = options.storage;
        if (directory && storage && !TERMINAL.has(copy.status))
            void persist(a, () => storage.snapshot(directory, copy)).catch((error) =>
                platform.log(`Workflow snapshot persistence failed: ${errorMessage(error)}`),
            );
    };
    const publishTerminal = (a: ActiveRun, result: unknown) => {
        if (a.interrupted) return;
        a.summary.updatedAt = now();
        const copy = structuredClone(a.summary),
            directory = a.directory,
            storage = options.storage;
        if (directory && storage)
            void persist(a, () => storage.terminal(directory, result, copy)).catch((error) =>
                platform.log(`Workflow terminal persistence failed: ${errorMessage(error)}`),
            );
        emit(copy);
    };
    const waitWhilePaused = async (active: ActiveRun) => {
        while (active.paused)
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(new Error("Workflow stopped while paused."));
                active.controller.signal.addEventListener("abort", abort, { once: true });
                active.resumeWaiters.push(() => {
                    active.controller.signal.removeEventListener("abort", abort);
                    resolve();
                });
            });
    };
    const finishPhase = (a: ActiveRun, status: "succeeded" | "failed" | "cancelled", error?: string) => {
        const phase = a.summary.phases.find((p) => p.id === a.summary.currentPhase);
        if (phase?.status === "running") {
            phase.status = status;
            phase.endedAt = phase.updatedAt = now();
            if (error) phase.error = error;
        }
    };
    const execute = async (active: ActiveRun, input: WorkflowLaunch, node: string) => {
        let directory: string | undefined,
            terminal = false,
            stderr = "";
        const finish = (status: "succeeded" | "failed" | "cancelled", error?: string, json?: string) => {
            if (terminal || active.interrupted) return;
            let result: unknown = null;
            if (json !== undefined)
                try {
                    result = JSON.parse(json);
                } catch {
                    status = "failed";
                    error = "Malformed workflow result.";
                    json = undefined;
                }
            terminal = true;
            active.summary.status = status;
            active.summary.endedAt = now();
            if (error) active.summary.error = error.slice(0, 2000);
            if (json !== undefined) active.result = json;
            finishPhase(active, status, error);
            publishTerminal(active, result);
        };
        try {
            directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-"));
            const worker = path.join(directory, "worker.mjs");
            await fs.promises.writeFile(worker, platform.workerSource, { mode: 0o600 });
            const canonical = await realpath(worker);
            const child = spawn(
                node,
                ["--permission", `--allow-fs-read=${canonical}`, "--max-old-space-size=128", canonical],
                { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: {} },
            );
            active.child = child;
            const terminate = () => {
                try {
                    process.platform !== "win32" && child.pid
                        ? process.kill(-child.pid, "SIGTERM")
                        : child.kill("SIGTERM");
                } catch {}
                setTimeout(() => {
                    try {
                        process.platform !== "win32" && child.pid
                            ? process.kill(-child.pid, "SIGKILL")
                            : child.kill("SIGKILL");
                    } catch {}
                }, 500).unref();
            };
            active.controller.signal.addEventListener("abort", terminate, { once: true });
            if (active.controller.signal.aborted) terminate();
            else {
                active.summary.status = "running";
                active.summary.startedAt = now();
                publish(active);
            }
            if (!child.stdin || !child.stdout) throw new Error("Workflow worker pipes were not created.");
            let pending = 0,
                agents = 0,
                shells = 0,
                phaseId: string | undefined,
                ready = false,
                lastBeat = now();
            child.stdin.on("error", (error: NodeJS.ErrnoException) => {
                if (error.code !== "EPIPE") finish("failed", errorMessage(error));
            });
            const send = (frame: unknown) => {
                const payload = `${boundedJson(frame)}\n`;
                if (!child.stdin.writable || child.stdin.writableEnded || child.stdin.destroyed) return false;
                return child.stdin.write(payload);
            };
            const handle = async (inputFrame: unknown) => {
                const frame = parseWorkerFrame(inputFrame, { ready, pending });
                if (frame.t === "ready") {
                    ready = true;
                    lastBeat = now();
                    send({
                        v: 1,
                        t: "start",
                        script: executableWorkflowScript(input.script, input.entrypoint ?? "script"),
                        args: input.args,
                        entrypoint: input.entrypoint ?? "script",
                    });
                    return;
                }
                if (frame.t === "heartbeat") {
                    lastBeat = now();
                    return;
                }
                if (frame.t === "terminal") {
                    frame.ok ? finish("succeeded", undefined, frame.json) : finish("failed", frame.error);
                    child.stdin.end();
                    child.kill("SIGTERM");
                    return;
                }
                pending++;
                try {
                    let value: unknown = null;
                    if (frame.method === "phase") {
                        finishPhase(active, "succeeded");
                        const data =
                                frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
                                    ? (frame.value as Record<string, unknown>)
                                    : {},
                            name = String(data.name ?? "").slice(0, 512);
                        if (!name) throw new Error("Invalid phase");
                        phaseId = `phase-${active.summary.phases.length + 1}`;
                        active.summary.currentPhase = phaseId;
                        active.summary.phases.push({
                            id: phaseId,
                            name,
                            status: "running",
                            startedAt: now(),
                            updatedAt: now(),
                            agentIds: [],
                        });
                        publish(active);
                    } else if (frame.method === "log") {
                        const data =
                            frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
                                ? (frame.value as Record<string, unknown>)
                                : {};
                        active.summary.recentActivity.push({
                            sequence: (active.summary.recentActivity.at(-1)?.sequence ?? 0) + 1,
                            timestamp: now(),
                            kind: "log",
                            title: String(data.message ?? "").slice(0, 2000),
                        });
                        active.summary.recentActivity = active.summary.recentActivity.slice(-20);
                        publish(active);
                    } else if (frame.method === "shell") {
                        if (++shells > MAX_SHELL_INVOCATIONS) throw new Error("Workflow shell cap exceeded.");
                        const operationId = workflowOperationId("shell", frame.identity);
                        if (active.completions.has(operationId)) {
                            value = structuredClone(active.completions.get(operationId));
                            send({ v: 1, t: "reply", id: frame.id, ok: true, json: boundedJson(value) });
                            return;
                        }
                        await waitWhilePaused(active);
                        const request = validateShellRequest(frame.value);
                        const activity: WorkflowActivityV1 = {
                            sequence: (active.summary.recentActivity.at(-1)?.sequence ?? 0) + 1,
                            timestamp: now(),
                            kind: "tool" as const,
                            title: `$ ${request.command}`.slice(0, 2000),
                        };
                        active.summary.recentActivity.push(activity);
                        active.summary.recentActivity = active.summary.recentActivity.slice(-20);
                        publish(active);
                        value = await runDurableOperation({
                            run: active,
                            operationId,
                            timeoutMs: request.timeoutMs,
                            timeoutMessage: "Shell command timed out.",
                            cooperative: true,
                            now,
                            execute: (signal) =>
                                Promise.resolve(
                                    shellExecutor({
                                        command: request.command,
                                        cwd: input.cwd,
                                        env: request.env,
                                        signal,
                                        timeoutMs: request.timeoutMs,
                                    }),
                                ),
                            validateResult: (result) => {
                                validateShellResult(result);
                                boundedJson(result);
                                return result;
                            },
                            journal: async (durable, at) => {
                                if (active.directory)
                                    await options.storage?.complete(active.directory, operationId, durable, at);
                            },
                            onSettled: (failure) => {
                                if (failure) activity.isError = true;
                                publish(active);
                            },
                        });
                    } else if (frame.method === "agent") {
                        if (++agents > active.summary.limits.maxAgents) throw new Error("Workflow agent cap exceeded.");
                        if (agents === LARGE_RUN_WARNING_AGENTS) {
                            active.summary.warning = `Large workflow run: ${LARGE_RUN_WARNING_AGENTS} agents scheduled.`;
                            publish(active);
                        }
                        const operationId = workflowOperationId("agent", frame.identity);
                        if (active.completions.has(operationId)) {
                            value = structuredClone(active.completions.get(operationId));
                            send({ v: 1, t: "reply", id: frame.id, ok: true, json: boundedJson(value) });
                            return;
                        }
                        await waitWhilePaused(active);
                        const request = validateAgentRequest(frame.value, {
                            policy: options.policy,
                            activeSharedWriters: active.activeSharedWriters,
                        });
                        const agent: WorkflowAgentSummaryV1 = {
                            id: operationId,
                            label: request.label,
                            role: request.role,
                            ...(request.model ? { model: request.model } : {}),
                            status: "running",
                            phaseId,
                            startedAt: now(),
                            updatedAt: now(),
                            usage: emptyUsage(),
                            prompt: request.prompt.slice(0, 8000),
                            recentActivity: [],
                        };
                        active.summary.agents.push(agent);
                        if (phaseId) active.summary.phases.find((p) => p.id === phaseId)?.agentIds.push(agent.id);
                        publish(active);
                        let sharedWriter = false,
                            owned: Awaited<ReturnType<WorkflowWorktreeManager["create"]>> | undefined,
                            operationKey: string | undefined;
                        value = await runDurableOperation({
                            run: active,
                            operationId,
                            timeoutMs: request.timeoutMs,
                            timeoutMessage: "Agent timed out.",
                            cooperative: options.cooperativeExecutor === true,
                            now,
                            beforeExecute: async () => {
                                if (request.writeCapable && request.isolation !== "worktree") {
                                    if (active.activeSharedWriters > 0 && !options.policy?.allowUnsafeSharedCheckout)
                                        throw new Error("Concurrent write-capable agents require worktree isolation.");
                                    active.activeSharedWriters++;
                                    sharedWriter = true;
                                }
                                await waitWhilePaused(active);
                            },
                            setup: async () => {
                                if (request.isolation !== "worktree") return;
                                operationKey = `${operationId.slice(0, 35)}-${platform.uuid().slice(0, 8)}`;
                                owned = await worktrees.create(input.cwd, active.summary.id.slice(0, 63), operationKey);
                                if (active.directory && options.storage)
                                    await options.storage.worktree(active.directory, operationKey, owned, now());
                                agent.worktree = { cwd: owned.cwd, branch: owned.branch };
                                agent.recentActivity.push({
                                    sequence: 1,
                                    timestamp: now(),
                                    kind: "diagnostic",
                                    title: `Worktree ${owned.branch} at ${owned.cwd}`.slice(0, 2000),
                                });
                                publish(active);
                            },
                            execute: async (signal) => {
                                let result: AgentResult | undefined;
                                for (let attempt = 0; attempt <= request.retries; attempt++)
                                    try {
                                        result = await options.agentExecutor({
                                            prompt: request.prompt,
                                            role: request.role,
                                            model: request.model,
                                            schema: request.schema,
                                            signal,
                                            timeoutMs: request.timeoutMs,
                                            cwd: owned?.cwd ?? input.cwd,
                                        });
                                        if (!schemaValid(result.value, request.schema))
                                            throw new Error("Agent result does not match schema.");
                                        break;
                                    } catch (e) {
                                        if (attempt === request.retries || signal.aborted) throw e;
                                    }
                                if (!result) throw new Error("Agent produced no result.");
                                return result;
                            },
                            validateResult: (result) => {
                                const durable = result.value;
                                boundedJson(durable);
                                const nextTokens =
                                        active.summary.usage.totalTokens + (Number(result.usage?.totalTokens) || 0),
                                    nextCost = active.summary.usage.cost + (Number(result.usage?.cost) || 0);
                                addUsage(agent.usage, result.usage);
                                addUsage(active.summary.usage, result.usage);
                                if (active.summary.limits.maxTokens && nextTokens > active.summary.limits.maxTokens)
                                    throw new Error(
                                        `Workflow token budget exceeded (${nextTokens}/${active.summary.limits.maxTokens}).`,
                                    );
                                if (active.summary.limits.maxCost && nextCost > active.summary.limits.maxCost)
                                    throw new Error(
                                        `Workflow cost budget exceeded (${nextCost}/${active.summary.limits.maxCost}).`,
                                    );
                                return durable;
                            },
                            journal: async (durable, at) => {
                                if (active.directory)
                                    await options.storage?.complete(active.directory, operationId, durable, at);
                            },
                            onSuccess: () => {
                                agent.status = "succeeded";
                            },
                            cleanup: async () => {
                                if (!owned) return;
                                await worktrees.cleanup(input.cwd, owned);
                                if (operationKey && active.directory && options.storage)
                                    await options.storage.worktree(active.directory, operationKey, null, now());
                            },
                            onSettled: (failure) => {
                                if (failure) {
                                    agent.status = active.controller.signal.aborted
                                        ? "cancelled"
                                        : errorMessage(failure.error).includes("timed out")
                                          ? "timed_out"
                                          : "failed";
                                    agent.error = errorMessage(failure.error).slice(0, 2000);
                                }
                                if (sharedWriter) active.activeSharedWriters--;
                                agent.endedAt = agent.updatedAt = now();
                                publish(active);
                            },
                        });
                    } else throw new Error(`Unknown workflow RPC method: ${frame.method}`);
                    send({ v: 1, t: "reply", id: frame.id, ok: true, json: boundedJson(value) });
                } catch (e) {
                    send({ v: 1, t: "reply", id: frame.id, ok: false, error: errorMessage(e).slice(0, 2000) });
                } finally {
                    pending--;
                }
            };
            child.stderr?.on("data", (c) => {
                stderr = Buffer.from(`${stderr}${c}`).subarray(-STDERR_BYTES).toString();
            });
            child.stdout.setEncoding("utf8");
            const decoder = new WorkerFrameDecoder();
            child.stdout.on("data", (chunk) => {
                try {
                    for (const parsed of decoder.decode(chunk))
                        void handle(parsed).catch((e) => {
                            finish("failed", errorMessage(e));
                            active.controller.abort();
                        });
                } catch (e) {
                    finish("failed", errorMessage(e));
                    active.controller.abort();
                }
            });
            const watchdog = setInterval(() => {
                const limit = ready ? platform.watchdogMs : platform.readyTimeoutMs;
                if (now() - lastBeat > limit) {
                    finish(
                        "failed",
                        ready ? "Workflow worker heartbeat timed out." : "Workflow worker did not become ready.",
                    );
                    active.controller.abort();
                }
            }, 250);
            const total = setTimeout(() => {
                finish("failed", "Workflow run timed out.");
                active.controller.abort();
            }, platform.runTimeoutMs ?? active.summary.limits.timeoutMs);
            await new Promise<void>((resolve) => {
                child.once("error", (e) => {
                    finish("failed", errorMessage(e));
                    resolve();
                });
                child.once("close", () => {
                    if (!terminal)
                        finish(
                            active.controller.signal.aborted ? "cancelled" : "failed",
                            active.controller.signal.aborted
                                ? undefined
                                : `Workflow worker exited without a terminal result.${stderr ? ` ${stderr}` : ""}`,
                        );
                    resolve();
                });
            });
            clearInterval(watchdog);
            clearTimeout(total);
        } catch (e) {
            finish(active.controller.signal.aborted ? "cancelled" : "failed", errorMessage(e));
        } finally {
            active.child = undefined;
            await active.persistence;
            if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
        }
    };
    return {
        async launch(input, signal) {
            if (shuttingDown) throw new Error("Workflow backend is shutting down.");
            const checkCancelled = () => {
                if (signal?.aborted) throw new Error("Workflow launch was cancelled.");
            };
            let durableDirectory: string | undefined;
            pendingLaunches++;
            try {
                checkCancelled();
                validateLaunchMetadata(input);
                preflightWorkflow(input.script, input.entrypoint);
                input = { ...input, cwd: await worktrees.repository(input.cwd).catch(async () => realpath(input.cwd)) };
                checkCancelled();
                if (shuttingDown) throw new Error("Workflow backend is shutting down.");
                const node = await resolveWorkflowNode({
                    environment: options.environment,
                    configuredPath: options.nodePath,
                });
                checkCancelled();
                if (shuttingDown) throw new Error("Workflow backend is shutting down.");
                const id = platform.uuid(),
                    timestamp = now(),
                    controller = new AbortController(),
                    limits = normalizeWorkflowLimits(input.limits ?? {});
                const summary: WorkflowRunSummaryV1 = {
                    schema: "pi.workflow",
                    version: 1,
                    id,
                    name: input.name,
                    sessionId: input.sessionId,
                    cwd: input.cwd,
                    status: "queued",
                    phases: [],
                    agents: [],
                    usage: emptyUsage(),
                    limits,
                    recentActivity: [],
                    updatedAt: timestamp,
                };
                const active: ActiveRun = {
                    summary,
                    script: input.script,
                    controller,
                    settlement: Promise.resolve(),
                    cooperativeTasks: new Set(),
                    completions: new Map(input.seedCompletions ?? []),
                    paused: false,
                    resumeWaiters: [],
                    persistence: Promise.resolve(),
                    input: { ...input, limits: input.limits },
                    semaphore: new AbortableSemaphore(limits.maxConcurrency),
                    activeSharedWriters: 0,
                };
                if (options.storage) {
                    const durableCwd = await realpath(input.cwd);
                    checkCancelled();
                    active.directory = durableDirectory = await options.storage.create(
                        input.cwd,
                        id,
                        {
                            name: input.name,
                            sessionId: input.sessionId,
                            cwd: durableCwd,
                            script: input.script,
                            entrypoint: input.entrypoint ?? "script",
                            args: input.args,
                            policy: options.policy ?? {},
                            roles: options.policy?.roles ?? [],
                            models: options.policy?.models ?? [],
                            limits,
                            parentRunId: input.parentRunId,
                        },
                        summary,
                    );
                    checkCancelled();
                }
                if (active.directory && options.storage)
                    for (const [operation, value] of active.completions) {
                        await options.storage.complete(active.directory, operation, value, now());
                        checkCancelled();
                    }
                if (shuttingDown) throw new Error("Workflow backend is shutting down.");
                runs.set(id, active);
                durableDirectory = undefined;
                publish(active);
                active.settlement = execute(active, input, node).catch(async (e) => {
                    if (!active.interrupted && !TERMINAL.has(active.summary.status)) {
                        active.summary.status = "failed";
                        active.summary.endedAt = now();
                        active.summary.error = errorMessage(e);
                        publishTerminal(active, null);
                        await active.persistence;
                    }
                });
                return { runId: id };
            } catch (error) {
                if (durableDirectory)
                    await fs.promises.rm(durableDirectory, { recursive: true, force: true }).catch(() => {});
                throw error;
            } finally {
                pendingLaunches--;
                if (pendingLaunches === 0) pendingLaunchWaiter?.();
            }
        },
        async initialize(cwd) {
            if (!options.storage) return [];
            for (const stored of await options.storage.discover(cwd)) {
                if (runs.has(stored.id)) continue;
                for (const [operation, owned] of stored.worktrees) {
                    await worktrees.cleanup(stored.launch.cwd, owned);
                    await options.storage.worktree(stored.directory, operation, null, now());
                }
                const controller = new AbortController(),
                    limits = { ...DEFAULT_WORKFLOW_LIMITS, ...(stored.launch.limits as object) };
                const summary = structuredClone(stored.snapshot);
                if (!TERMINAL.has(summary.status)) {
                    // A snapshot can lag the journal. Keep only durable agents and rebuild references;
                    // replay will recreate every interrupted operation with the same stable identity.
                    summary.agents = summary.agents
                        .filter((agent) => stored.completions.has(agent.id))
                        .map((agent) => ({ ...agent, status: "succeeded" as const, error: undefined }));
                    const durable = new Set(summary.agents.map((agent) => agent.id));
                    summary.phases = summary.phases.map((phase) => ({
                        ...phase,
                        status: phase.status === "running" ? "queued" : phase.status,
                        agentIds: phase.agentIds.filter((agentId) => durable.has(agentId)),
                    }));
                    summary.currentPhase = undefined;
                    summary.endedAt = undefined;
                    summary.error = undefined;
                }
                runs.set(stored.id, {
                    summary,
                    script: stored.launch.script,
                    controller,
                    settlement: Promise.resolve(),
                    cooperativeTasks: new Set(),
                    directory: stored.corrupt ? undefined : stored.directory,
                    completions: new Map(stored.completions),
                    paused: true,
                    resumeWaiters: [],
                    persistence: Promise.resolve(),
                    input: {
                        name: stored.launch.name,
                        script: stored.launch.script,
                        entrypoint: stored.launch.entrypoint,
                        args: stored.launch.args,
                        sessionId: stored.launch.sessionId,
                        cwd: stored.launch.cwd,
                        limits,
                        parentRunId: stored.launch.parentRunId,
                    },
                    semaphore: new AbortableSemaphore(limits.maxConcurrency),
                    activeSharedWriters: 0,
                    ...(stored.result !== undefined ? { result: stored.result } : {}),
                });
            }
            return this.list();
        },
        async recover(id) {
            const active = runs.get(id);
            if (!active) throw new Error(`Unknown workflow run: ${id}`);
            if (TERMINAL.has(active.summary.status)) return;
            if (!active.paused) throw new Error("Workflow recovery is already running.");
            active.paused = false;
            active.summary.status = "queued";
            if (active.summary.warning === INTERRUPTION_WARNING) active.summary.warning = undefined;
            const node = await resolveWorkflowNode({
                environment: options.environment,
                configuredPath: options.nodePath,
            });
            active.settlement = execute(active, active.input, node);
        },
        list: () => [...runs.values()].map((r) => structuredClone(r.summary)),
        inspect(id) {
            const r = runs.get(id);
            if (!r) throw new Error(`Unknown workflow run: ${id}`);
            return {
                run: structuredClone(r.summary),
                script: r.script,
                ...(r.result !== undefined ? { result: r.result } : {}),
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async control(id, requestedControl) {
            const action = typeof requestedControl === "string" ? requestedControl : requestedControl.action;
            const run = runs.get(id);
            if (!run) throw new Error(`Unknown workflow run: ${id}`);
            if (action === "stop") {
                if (TERMINAL.has(run.summary.status)) return;
                run.stopping = true;
                run.controller.abort();
                if (!run.child) {
                    run.summary.status = "cancelled";
                    run.summary.endedAt = now();
                    publishTerminal(run, null);
                    await run.persistence;
                }
            } else if (action === "pause") {
                if (run.summary.status !== "running") throw new Error("Only a running workflow can be paused.");
                run.paused = true;
                run.summary.status = "paused";
                publish(run);
            } else if (action === "resume") {
                if (run.summary.status !== "paused") throw new Error("Only a paused workflow can be resumed.");
                run.paused = false;
                run.summary.status = "running";
                for (const wake of run.resumeWaiters.splice(0)) wake();
                publish(run);
            } else if (action === "retry") {
                if (!TERMINAL.has(run.summary.status)) throw new Error("Only a terminal workflow can be retried.");
                // Retry is expected replay: reuse every durable completion.
                return this.launch({ ...run.input, parentRunId: run.summary.id, seedCompletions: run.completions });
            } else if (action === "restart-agent") {
                if (!TERMINAL.has(run.summary.status))
                    throw new Error("Only a terminal workflow can restart an agent.");
                const agentId = typeof requestedControl === "object" ? requestedControl.agentId : undefined;
                if (
                    !agentId ||
                    !run.summary.agents.some((agent) => agent.id === agentId) ||
                    !run.completions.has(agentId)
                )
                    throw new Error("Invalid completed agent identity.");
                const seed = new Map(run.completions);
                seed.delete(agentId);
                return this.launch({ ...run.input, parentRunId: run.summary.id, seedCompletions: seed });
            } else throw new Error(`Unknown workflow control: ${action}`);
            return {};
        },
        async claimTerminalDelivery(id, claimOptions) {
            const run = runs.get(id);
            if (!run?.directory || !options.storage || !TERMINAL.has(run.summary.status)) return false;
            await run.persistence;
            return claimOptions?.recovery
                ? options.storage.recoverDeliveryClaim(run.directory)
                : options.storage.claimDelivery(run.directory);
        },
        async markTerminalDelivered(id) {
            const run = runs.get(id);
            if (!run?.directory || !options.storage) throw new Error(`Unknown durable workflow run: ${id}`);
            await options.storage.markDelivered(run.directory);
        },
        async releaseTerminalDelivery(id) {
            const run = runs.get(id);
            if (run?.directory && options.storage) await options.storage.releaseClaim(run.directory);
        },
        async shutdown() {
            if (shuttingDown) return;
            shuttingDown = true;
            if (pendingLaunches > 0) {
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    new Promise<void>((resolve) => (pendingLaunchWaiter = resolve)),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, platform.shutdownGraceMs);
                    }),
                ]);
                if (timer) clearTimeout(timer);
            }
            const interrupted = [...runs.values()].filter((run) => !TERMINAL.has(run.summary.status) && !run.stopping);
            for (const run of interrupted) {
                run.interrupted = true;
                run.paused = true;
                run.summary.status = "paused";
                run.summary.warning = INTERRUPTION_WARNING;
                run.summary.endedAt = undefined;
                run.summary.error = undefined;
                run.summary.updatedAt = now();
                const runDirectory = run.directory;
                const storage = options.storage;
                if (runDirectory && storage)
                    await persist(run, () => storage.snapshot(runDirectory, structuredClone(run.summary)));
            }
            for (const run of interrupted) run.controller.abort();
            await Promise.allSettled([...runs.values()].map((r) => r.settlement));
            const cooperative = [...runs.values()].flatMap((r) => [...r.cooperativeTasks]);
            if (cooperative.length) {
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    Promise.allSettled(cooperative),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, platform.shutdownGraceMs);
                    }),
                ]);
                if (timer) clearTimeout(timer);
                if ([...runs.values()].some((r) => r.cooperativeTasks.size))
                    platform.log("Workflow executor shutdown grace expired; child cleanup may be incomplete.");
            }
            listeners.clear();
        },
    };
}
