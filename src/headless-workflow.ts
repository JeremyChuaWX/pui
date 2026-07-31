import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, childArgs, type ResolvedAgentName, resolveModel } from "../extensions/subagent/presets.js";
import { createInitialSubagentDetails } from "../extensions/subagent/protocol.js";
import { getPiInvocation, runSubagent } from "../extensions/subagent/runner.js";
import type { WorkflowBackend, WorkflowBackendOptions } from "../extensions/workflow/backend.js";
import { createWorkflowBackend } from "../extensions/workflow/backend.js";
import type { WorkflowRunSummaryV1 } from "../extensions/workflow/protocol.js";
import { WorkflowRunStorage } from "../extensions/workflow/run-storage.js";
import { readWorkflowFile } from "../extensions/workflow/source.js";

const HEADLESS_WORKFLOW_SESSION_PREFIX = "headless-";
const TERMINAL_WORKFLOW_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function isHeadlessWorkflowSession(sessionId: string): boolean {
    return sessionId.startsWith(HEADLESS_WORKFLOW_SESSION_PREFIX);
}

function compactProgressText(value: string, maximum = 200): string {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function createProgressObserver(report: (message: string) => void): (run: WorkflowRunSummaryV1) => void {
    let phaseId: string | undefined;
    let lastActivitySequence = 0;
    let terminalStatus: string | undefined;
    const agentStatuses = new Map<string, string>();
    return (run) => {
        const phase = run.phases.find((item) => item.id === run.currentPhase);
        if (phase && phase.id !== phaseId) {
            phaseId = phase.id;
            report(`phase: ${compactProgressText(phase.name)}`);
        }
        for (const activity of run.recentActivity) {
            if (activity.sequence <= lastActivitySequence) continue;
            lastActivitySequence = activity.sequence;
            const prefix = activity.kind === "tool" ? "shell" : activity.kind;
            report(`${prefix}: ${compactProgressText(activity.title)}`);
        }
        for (const agent of run.agents) {
            const previous = agentStatuses.get(agent.id);
            if (previous === agent.status) continue;
            agentStatuses.set(agent.id, agent.status);
            report(`agent ${agent.status}: ${compactProgressText(agent.label)}`);
        }
        if (TERMINAL_WORKFLOW_STATUSES.has(run.status) && terminalStatus !== run.status) {
            terminalStatus = run.status;
            report(run.status === "succeeded" ? "completed" : run.status);
        }
    };
}

export function createWorkflowAgentExecutor(
    environment: NodeJS.ProcessEnv = process.env,
): WorkflowBackendOptions["agentExecutor"] {
    return async (request) => {
        if (!Object.hasOwn(AGENTS, request.role))
            throw new Error(`Agent role is not allowed by host policy: ${request.role}`);
        const role = request.role as ResolvedAgentName;
        const preset = AGENTS[role];
        const model = resolveModel(preset, request.model, environment);
        const prompt = request.schema
            ? `${request.prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.schema)}`
            : request.prompt;
        const invocation = getPiInvocation(childArgs(preset, model, prompt));
        const result = await runSubagent({
            details: createInitialSubagentDetails({
                id: crypto.randomUUID(),
                agent: role,
                model: model ?? "default",
                cwd: request.cwd,
            }),
            command: invocation.command,
            args: invocation.args,
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
            signal: request.signal,
        });
        if (result.details.run.status !== "succeeded")
            throw new Error(result.details.run.error ?? `Child Pi ${result.details.run.status}.`);
        let value: unknown = result.output;
        if (request.schema)
            try {
                value = JSON.parse(result.output);
            } catch {
                throw new Error("Child Pi returned invalid structured JSON.");
            }
        return { value, usage: result.details.run.usage };
    };
}

export interface HeadlessWorkflowCliOptions {
    path: string;
    cwd: string;
    args?: unknown;
}

export function parseHeadlessWorkflowArgs(argv: string[], cwd = process.cwd()): HeadlessWorkflowCliOptions {
    const values = [...argv];
    if (values[0] === "--cwd") {
        if (!values[1]) throw new Error("workflow --cwd requires a path");
        cwd = path.resolve(cwd, values.splice(0, 2)[1] as string);
    }
    const workflowPath = values.shift();
    if (!workflowPath || values.length > 1) throw new Error("Usage: pui workflow [--cwd <path>] <file.ts> [JSON args]");
    if (values[0] === undefined) return { path: workflowPath, cwd };
    try {
        return { path: workflowPath, cwd, args: JSON.parse(values[0]) };
    } catch {
        throw new Error("Workflow arguments must be valid JSON.");
    }
}

export interface HeadlessWorkflowOptions {
    path: string;
    cwd?: string;
    args?: unknown;
    environment?: NodeJS.ProcessEnv;
    backend?: WorkflowBackend;
    /** Human-readable lifecycle updates. CLI callers should send these to stderr. */
    onProgress?: (message: string) => void;
}

/** Run an explicitly selected workflow without creating a UI or Pi session. */
export async function runHeadlessWorkflow(options: HeadlessWorkflowOptions): Promise<unknown> {
    const report = (message: string) => {
        try {
            options.onProgress?.(message);
        } catch {
            // Feedback must never be able to strand a workflow.
        }
    };
    const cwd = await fs.promises.realpath(options.cwd ?? process.cwd());
    const source = await readWorkflowFile(cwd, options.path);
    report(`starting ${source.name}`);
    const environment = options.environment ?? process.env;
    const backend =
        options.backend ??
        createWorkflowBackend({
            agentExecutor: createWorkflowAgentExecutor(environment),
            cooperativeExecutor: true,
            environment,
            storage: new WorkflowRunStorage(),
            policy: {
                roles: ["generic", "worker", "explore"],
                resolveModel: (role, requested) =>
                    resolveModel(AGENTS[role as ResolvedAgentName], requested, environment),
            },
        });
    let runId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
        let resolveTerminal: () => void = () => {};
        const terminal = new Promise<void>((resolve) => (resolveTerminal = resolve));
        const observeProgress = createProgressObserver(report);
        unsubscribe = backend.subscribe((run) => {
            if (run.id !== runId) return;
            observeProgress(run);
            if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) resolveTerminal();
        });
        ({ runId } = await backend.launch({
            name: source.name,
            script: source.script,
            entrypoint: "function",
            args: options.args,
            sessionId: `${HEADLESS_WORKFLOW_SESSION_PREFIX}${crypto.randomUUID()}`,
            cwd,
        }));
        report(`launched ${runId.slice(0, 8)}`);
        let inspected = backend.inspect(runId);
        observeProgress(inspected.run);
        if (!TERMINAL_WORKFLOW_STATUSES.has(inspected.run.status)) await terminal;
        inspected = backend.inspect(runId);
        if (inspected.run.status !== "succeeded")
            throw new Error(inspected.run.error ?? `Workflow ${inspected.run.status}.`);
        return inspected.result === undefined ? null : JSON.parse(inspected.result);
    } finally {
        unsubscribe?.();
        if (!options.backend) await backend.shutdown();
    }
}
