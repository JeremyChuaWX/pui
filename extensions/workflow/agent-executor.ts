import { getPiInvocation, PROCESS_CHILD_AGENT_SEMAPHORE, runChildAgent } from "../shared/child-agent.js";
import { agentPreset, childArgs, RESOLVED_AGENT_NAMES, resolveModel } from "../shared/presets.js";
import type { AbortableSemaphore } from "../shared/semaphore.js";
import { createWorkflowBackend, type WorkflowBackend, type WorkflowBackendOptions } from "./backend.js";
import { WorkflowRunStorage } from "./run-storage.js";

export const HEADLESS_WORKFLOW_SESSION_PREFIX = "headless-";
const HEADLESS_WORKFLOW_SESSION_PATTERN =
    /^headless-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isHeadlessWorkflowSession(sessionId: string): boolean {
    return HEADLESS_WORKFLOW_SESSION_PATTERN.test(sessionId);
}

export interface WorkflowAgentExecutorOverrides {
    semaphore?: AbortableSemaphore;
    run?: typeof runChildAgent;
    invocation?: typeof getPiInvocation;
}

/** The default agent executor: run each workflow agent as a child Pi process. */
export function createWorkflowAgentExecutor(
    environment: NodeJS.ProcessEnv = process.env,
    overrides: WorkflowAgentExecutorOverrides = {},
): WorkflowBackendOptions["agentExecutor"] {
    return async (request) => {
        const preset = agentPreset(request.role);
        if (!preset) throw new Error(`Agent role is not allowed by host policy: ${request.role}`);
        const model = resolveModel(preset, request.model, environment);
        const prompt = request.schema
            ? `${request.prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.schema)}`
            : request.prompt;
        const invocation = (overrides.invocation ?? getPiInvocation)(childArgs(preset, model, prompt));
        const release = await (overrides.semaphore ?? PROCESS_CHILD_AGENT_SEMAPHORE).acquire(request.signal);
        let result: Awaited<ReturnType<typeof runChildAgent>>;
        try {
            result = await (overrides.run ?? runChildAgent)({
                command: invocation.command,
                args: invocation.args,
                cwd: request.cwd,
                timeoutMs: request.timeoutMs,
                model: model ?? "default",
                signal: request.signal,
            });
        } finally {
            release();
        }
        if (result.status !== "succeeded") throw new Error(result.error ?? `Child Pi ${result.status}.`);
        let value: unknown = result.output;
        if (request.schema)
            try {
                value = JSON.parse(result.output);
            } catch {
                throw new Error("Child Pi returned invalid structured JSON.");
            }
        return { value, usage: result.usage };
    };
}

export function defaultWorkflowPolicy(environment: NodeJS.ProcessEnv): WorkflowBackendOptions["policy"] {
    return {
        roles: [...RESOLVED_AGENT_NAMES],
        resolveModel: (role, requested) => {
            const preset = agentPreset(role);
            if (!preset) throw new Error(`Agent role is not allowed by host policy: ${role}`);
            return resolveModel(preset, requested, environment);
        },
        defaultTimeoutMs: (role) => agentPreset(role)?.timeoutMs,
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
