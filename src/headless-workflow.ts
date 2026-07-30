import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, childArgs, type ResolvedAgentName, resolveModel } from "../extensions/subagent/presets.js";
import { createInitialSubagentDetails } from "../extensions/subagent/protocol.js";
import { getPiInvocation, runSubagent } from "../extensions/subagent/runner.js";
import type { WorkflowBackend, WorkflowBackendOptions } from "../extensions/workflow/backend.js";
import { createWorkflowBackend } from "../extensions/workflow/backend.js";
import { WorkflowRunStorage } from "../extensions/workflow/run-storage.js";
import { readWorkflowFile } from "../extensions/workflow/source.js";

export function createWorkflowAgentExecutor(
    environment: NodeJS.ProcessEnv = process.env,
): WorkflowBackendOptions["agentExecutor"] {
    return async (request) => {
        const role = request.role as ResolvedAgentName;
        const preset = AGENTS[role];
        if (!preset) throw new Error(`Agent role is not allowed by host policy: ${request.role}`);
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
}

/** Run an explicitly selected workflow without creating a UI or Pi session. */
export async function runHeadlessWorkflow(options: HeadlessWorkflowOptions): Promise<unknown> {
    const cwd = await fs.promises.realpath(options.cwd ?? process.cwd());
    const source = await readWorkflowFile(cwd, options.path);
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
    try {
        let resolveTerminal: () => void = () => {};
        const terminal = new Promise<void>((resolve) => (resolveTerminal = resolve));
        const unsubscribe = backend.subscribe((run) => {
            if (run.id === runId && ["succeeded", "failed", "cancelled"].includes(run.status)) resolveTerminal();
        });
        ({ runId } = await backend.launch({
            name: source.name,
            script: source.script,
            entrypoint: "function",
            args: options.args,
            sessionId: `headless-${crypto.randomUUID()}`,
            cwd,
        }));
        if (!["succeeded", "failed", "cancelled"].includes(backend.inspect(runId).run.status)) await terminal;
        unsubscribe();
        const inspected = backend.inspect(runId);
        if (inspected.run.status !== "succeeded")
            throw new Error(inspected.run.error ?? `Workflow ${inspected.run.status}.`);
        return inspected.result === undefined ? null : JSON.parse(inspected.result);
    } finally {
        await backend.shutdown();
    }
}
