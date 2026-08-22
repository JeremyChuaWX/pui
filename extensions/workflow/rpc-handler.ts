import { errorMessage } from "../../shared/lib/validate.js";
import type { AgentExecutor, AgentResult, ShellExecutor, WorkflowHostPolicy, WorkflowRunStore } from "./backend.js";
import type { WorkflowActivityV1, WorkflowAgentSummaryV1, WorkflowRunSummaryV1, WorkflowUsageV1 } from "./protocol.js";
import {
    boundedJson,
    type DurableOperationRun,
    runDurableOperation,
    schemaValid,
    validateAgentRequest,
    validateShellRequest,
    validateShellResult,
    workflowOperationId,
} from "./rpc-operations.js";
import type { ParsedWorkerFrame } from "./worker-protocol.js";
import type { WorkflowWorktreeManager } from "./worktree.js";

const LARGE_RUN_WARNING_AGENTS = 25,
    MAX_SHELL_INVOCATIONS = 1_000;

export type WorkerRpcFrame = Extract<ParsedWorkerFrame, { t: "rpc" }>;

export const emptyWorkflowUsage = (): WorkflowUsageV1 => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
});
const addUsage = (target: WorkflowUsageV1, value: Partial<WorkflowUsageV1> = {}) => {
    for (const key of Object.keys(target) as (keyof WorkflowUsageV1)[]) target[key] += Number(value[key]) || 0;
};

/** The slice of an active run the RPC handler reads and mutates. */
export interface RpcHandlerRun extends DurableOperationRun {
    summary: WorkflowRunSummaryV1;
    directory?: string;
    activeSharedWriters: number;
}

export interface RpcHandlerOptions {
    run: RpcHandlerRun;
    /** Workflow checkout directory; shell commands and non-isolated agents run here. */
    cwd: string;
    send: (frame: unknown) => boolean;
    now: () => number;
    uuid: () => string;
    publish: () => void;
    /** Marks the running phase succeeded before a new phase starts. */
    finishCurrentPhase: () => void;
    waitWhilePaused: () => Promise<void>;
    shellExecutor: ShellExecutor;
    agentExecutor: AgentExecutor;
    /** True for executors that honor abort and reap their child process. */
    cooperativeExecutor: boolean;
    policy?: WorkflowHostPolicy;
    storage?: Pick<WorkflowRunStore, "complete" | "worktree">;
    worktrees: Pick<WorkflowWorktreeManager, "create" | "cleanup">;
}

/**
 * RPC semantics for one workflow run: the phase/log/shell/agent dispatch, durable replay, and
 * reply framing. The caller owns frame transport, the in-flight counter, and terminal state.
 */
export function createRpcHandler(options: RpcHandlerOptions): (frame: WorkerRpcFrame) => Promise<void> {
    const { run, cwd, send, now, uuid, publish, finishCurrentPhase, waitWhilePaused } = options;
    let agents = 0,
        shells = 0,
        phaseId: string | undefined;
    return async (frame) => {
        try {
            let value: unknown = null;
            if (frame.method === "phase") {
                finishCurrentPhase();
                const data =
                        frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
                            ? (frame.value as Record<string, unknown>)
                            : {},
                    name = String(data.name ?? "").slice(0, 512);
                if (!name) throw new Error("Invalid phase");
                phaseId = `phase-${run.summary.phases.length + 1}`;
                run.summary.currentPhase = phaseId;
                run.summary.phases.push({
                    id: phaseId,
                    name,
                    status: "running",
                    startedAt: now(),
                    updatedAt: now(),
                    agentIds: [],
                });
                publish();
            } else if (frame.method === "log") {
                const data =
                    frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
                        ? (frame.value as Record<string, unknown>)
                        : {};
                run.summary.recentActivity.push({
                    sequence: (run.summary.recentActivity.at(-1)?.sequence ?? 0) + 1,
                    timestamp: now(),
                    kind: "log",
                    title: String(data.message ?? "").slice(0, 2000),
                });
                run.summary.recentActivity = run.summary.recentActivity.slice(-20);
                publish();
            } else if (frame.method === "shell") {
                if (++shells > MAX_SHELL_INVOCATIONS) throw new Error("Workflow shell cap exceeded.");
                const operationId = workflowOperationId("shell", frame.identity);
                if (run.completions.has(operationId)) {
                    value = structuredClone(run.completions.get(operationId));
                    send({ v: 1, t: "reply", id: frame.id, ok: true, json: boundedJson(value) });
                    return;
                }
                await waitWhilePaused();
                const request = validateShellRequest(frame.value);
                const activity: WorkflowActivityV1 = {
                    sequence: (run.summary.recentActivity.at(-1)?.sequence ?? 0) + 1,
                    timestamp: now(),
                    kind: "tool" as const,
                    title: `$ ${request.command}`.slice(0, 2000),
                };
                run.summary.recentActivity.push(activity);
                run.summary.recentActivity = run.summary.recentActivity.slice(-20);
                publish();
                value = await runDurableOperation({
                    run,
                    operationId,
                    timeoutMs: request.timeoutMs,
                    timeoutMessage: "Shell command timed out.",
                    cooperative: true,
                    now,
                    execute: (signal) =>
                        Promise.resolve(
                            options.shellExecutor({
                                command: request.command,
                                cwd,
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
                        if (run.directory) await options.storage?.complete(run.directory, operationId, durable, at);
                    },
                    onSettled: (failure) => {
                        if (failure) activity.isError = true;
                        publish();
                    },
                });
            } else if (frame.method === "agent") {
                if (++agents > run.summary.limits.maxAgents) throw new Error("Workflow agent cap exceeded.");
                if (agents === LARGE_RUN_WARNING_AGENTS) {
                    run.summary.warning = `Large workflow run: ${LARGE_RUN_WARNING_AGENTS} agents scheduled.`;
                    publish();
                }
                const operationId = workflowOperationId("agent", frame.identity);
                if (run.completions.has(operationId)) {
                    value = structuredClone(run.completions.get(operationId));
                    send({ v: 1, t: "reply", id: frame.id, ok: true, json: boundedJson(value) });
                    return;
                }
                await waitWhilePaused();
                const request = validateAgentRequest(frame.value, {
                    policy: options.policy,
                    activeSharedWriters: run.activeSharedWriters,
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
                    usage: emptyWorkflowUsage(),
                    prompt: request.prompt.slice(0, 8000),
                    recentActivity: [],
                };
                run.summary.agents.push(agent);
                if (phaseId) run.summary.phases.find((p) => p.id === phaseId)?.agentIds.push(agent.id);
                publish();
                let sharedWriter = false,
                    owned: Awaited<ReturnType<WorkflowWorktreeManager["create"]>> | undefined,
                    operationKey: string | undefined;
                value = await runDurableOperation({
                    run,
                    operationId,
                    timeoutMs: request.timeoutMs,
                    timeoutMessage: "Agent timed out.",
                    cooperative: options.cooperativeExecutor,
                    now,
                    beforeExecute: async () => {
                        if (request.writeCapable && request.isolation !== "worktree") {
                            if (run.activeSharedWriters > 0 && !options.policy?.allowUnsafeSharedCheckout)
                                throw new Error("Concurrent write-capable agents require worktree isolation.");
                            run.activeSharedWriters++;
                            sharedWriter = true;
                        }
                        await waitWhilePaused();
                    },
                    setup: async () => {
                        if (request.isolation !== "worktree") return;
                        operationKey = `${operationId.slice(0, 35)}-${uuid().slice(0, 8)}`;
                        owned = await options.worktrees.create(cwd, run.summary.id.slice(0, 63), operationKey);
                        if (run.directory && options.storage)
                            await options.storage.worktree(run.directory, operationKey, owned, now());
                        agent.worktree = { cwd: owned.cwd, branch: owned.branch };
                        agent.recentActivity.push({
                            sequence: 1,
                            timestamp: now(),
                            kind: "diagnostic",
                            title: `Worktree ${owned.branch} at ${owned.cwd}`.slice(0, 2000),
                        });
                        publish();
                    },
                    execute: async (signal) => {
                        let result: AgentResult | undefined;
                        // Every attempt reuses the worktree created in `setup`, so for
                        // isolation "worktree" agents retries are resume-style: they start
                        // from whatever state the failed attempt left, not a clean branch.
                        for (let attempt = 0; attempt <= request.retries; attempt++)
                            try {
                                result = await options.agentExecutor({
                                    prompt: request.prompt,
                                    role: request.role,
                                    model: request.model,
                                    schema: request.schema,
                                    signal,
                                    timeoutMs: request.timeoutMs,
                                    cwd: owned?.cwd ?? cwd,
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
                        const nextTokens = run.summary.usage.totalTokens + (Number(result.usage?.totalTokens) || 0),
                            nextCost = run.summary.usage.cost + (Number(result.usage?.cost) || 0);
                        addUsage(agent.usage, result.usage);
                        addUsage(run.summary.usage, result.usage);
                        if (run.summary.limits.maxTokens && nextTokens > run.summary.limits.maxTokens)
                            throw new Error(
                                `Workflow token budget exceeded (${nextTokens}/${run.summary.limits.maxTokens}).`,
                            );
                        if (run.summary.limits.maxCost && nextCost > run.summary.limits.maxCost)
                            throw new Error(
                                `Workflow cost budget exceeded (${nextCost}/${run.summary.limits.maxCost}).`,
                            );
                        return durable;
                    },
                    journal: async (durable, at) => {
                        if (run.directory) await options.storage?.complete(run.directory, operationId, durable, at);
                    },
                    onSuccess: () => {
                        agent.status = "succeeded";
                    },
                    cleanup: async () => {
                        if (!owned) return;
                        await options.worktrees.cleanup(cwd, owned);
                        if (operationKey && run.directory && options.storage)
                            await options.storage.worktree(run.directory, operationKey, null, now());
                    },
                    onSettled: (failure) => {
                        if (failure) {
                            agent.status = run.controller.signal.aborted
                                ? "cancelled"
                                : errorMessage(failure.error).includes("timed out")
                                  ? "timed_out"
                                  : "failed";
                            agent.error = errorMessage(failure.error).slice(0, 2000);
                        }
                        if (sharedWriter) run.activeSharedWriters--;
                        agent.endedAt = agent.updatedAt = now();
                        publish();
                    },
                });
            } else throw new Error(`Unknown workflow RPC method: ${frame.method}`);
            send({ v: 1, t: "reply", id: frame.id, ok: true, json: boundedJson(value) });
        } catch (e) {
            send({ v: 1, t: "reply", id: frame.id, ok: false, error: errorMessage(e).slice(0, 2000) });
        }
    };
}
