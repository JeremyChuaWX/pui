import { AGENTS, childArgs, type ResolvedAgentName, resolveModel } from "../subagent/presets.js";
import { createInitialSubagentDetails } from "../subagent/protocol.js";
import { getPiInvocation, runSubagent } from "../subagent/runner.js";
import { createWorkflowBackend, type WorkflowBackend, type WorkflowBackendOptions } from "./backend.js";
import { WorkflowRunStorage } from "./run-storage.js";

export const HEADLESS_WORKFLOW_SESSION_PREFIX = "headless-";
const HEADLESS_WORKFLOW_SESSION_PATTERN =
    /^headless-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isHeadlessWorkflowSession(sessionId: string): boolean {
    return HEADLESS_WORKFLOW_SESSION_PATTERN.test(sessionId);
}

/** The default agent executor: run each workflow agent as a child Pi process. */
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

export function defaultWorkflowPolicy(environment: NodeJS.ProcessEnv): WorkflowBackendOptions["policy"] {
    return {
        roles: ["generic", "worker", "explore"],
        resolveModel: (role, requested) => resolveModel(AGENTS[role as ResolvedAgentName], requested, environment),
    };
}

/** The production backend wiring shared by the extension, the headless CLI, and smoke tests. */
export function createDefaultWorkflowBackend(environment: NodeJS.ProcessEnv = process.env): WorkflowBackend {
    return createWorkflowBackend({
        agentExecutor: createWorkflowAgentExecutor(environment),
        cooperativeExecutor: true,
        environment,
        storage: new WorkflowRunStorage(),
        policy: defaultWorkflowPolicy(environment),
    });
}
