import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AbortableSemaphore } from "../../shared/lib/semaphore.js";
import { errorMessage } from "../../shared/lib/validate.js";
import { resolveWorkflowNode, runWorkflowShell } from "./node-resolution.js";
import { preflightWorkflow } from "./preflight.js";
import type { WorkflowEntrypoint, WorkflowLimitsV1, WorkflowRunSummaryV1, WorkflowUsageV1 } from "./protocol.js";
import { createRpcHandler, emptyWorkflowUsage } from "./rpc-handler.js";
import { DEFAULT_WORKFLOW_LIMITS, normalizeWorkflowLimits, validateLaunchMetadata } from "./rpc-operations.js";
import type { ImmutableRunLaunch, StoredRun } from "./run-storage.js";
import { executableWorkflowScript } from "./source.js";
import { WorkflowWorker } from "./worker-host.js";
import { WORKER_SOURCE } from "./worker-protocol.js";
import { type OwnedWorktree, WorkflowWorktreeManager } from "./worktree.js";

export { DEFAULT_WORKFLOW_LIMITS };

const READY_TIMEOUT_MS = 5_000,
    HEARTBEAT_TIMEOUT_MS = 5_000;
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
    /** Default agent timeout when the workflow requests none; still clamped by the workflow limit. */
    defaultTimeoutMs?: (role: string) => number | undefined;
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
    worker?: WorkflowWorker;
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
        let terminal = false;
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
        let worker: WorkflowWorker | undefined;
        try {
            let pending = 0;
            const handleRpc = createRpcHandler({
                run: active,
                cwd: input.cwd,
                send: (frame) => worker?.send(frame) ?? false,
                now,
                uuid: platform.uuid,
                publish: () => publish(active),
                finishCurrentPhase: () => finishPhase(active, "succeeded"),
                waitWhilePaused: () => waitWhilePaused(active),
                shellExecutor,
                agentExecutor: options.agentExecutor,
                cooperativeExecutor: options.cooperativeExecutor === true,
                policy: options.policy,
                storage: options.storage,
                worktrees,
            });
            worker = await WorkflowWorker.spawn({
                node,
                workerSource: platform.workerSource,
                signal: active.controller.signal,
                now,
                readyTimeoutMs: platform.readyTimeoutMs,
                watchdogMs: platform.watchdogMs,
                runTimeoutMs: platform.runTimeoutMs ?? active.summary.limits.timeoutMs,
                startFrame: () => ({
                    v: 1,
                    t: "start",
                    script: executableWorkflowScript(input.script, input.entrypoint ?? "script"),
                    args: input.args,
                    entrypoint: input.entrypoint ?? "script",
                }),
                pending: () => pending,
                onFrame: (frame) => {
                    if (frame.t === "terminal") {
                        frame.ok ? finish("succeeded", undefined, frame.json) : finish("failed", frame.error);
                        return;
                    }
                    pending++;
                    void handleRpc(frame)
                        .finally(() => pending--)
                        .catch((e) => {
                            finish("failed", errorMessage(e));
                            active.controller.abort();
                        });
                },
                onFailure: (message, failure) => {
                    finish("failed", message);
                    if (failure?.abort !== false) active.controller.abort();
                },
            });
            active.worker = worker;
            if (!active.controller.signal.aborted) {
                active.summary.status = "running";
                active.summary.startedAt = now();
                publish(active);
            }
            const exit = await worker.closed;
            if (exit.error !== undefined) finish("failed", errorMessage(exit.error));
            else
                finish(
                    active.controller.signal.aborted ? "cancelled" : "failed",
                    active.controller.signal.aborted
                        ? undefined
                        : `Workflow worker exited without a terminal result.${exit.stderr ? ` ${exit.stderr}` : ""}`,
                );
        } catch (e) {
            finish(active.controller.signal.aborted ? "cancelled" : "failed", errorMessage(e));
        } finally {
            active.worker = undefined;
            await active.persistence;
            await worker?.dispose();
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
                    usage: emptyWorkflowUsage(),
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
                if (!run.worker) {
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
