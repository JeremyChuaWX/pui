import type { EventBusController } from "@earendil-works/pi-coding-agent";
import {
    BACKGROUND_WORKFLOW_CHANNEL,
    BACKGROUND_WORKFLOW_CONTROL_CHANNEL,
    BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL,
    BACKGROUND_WORKFLOW_CONTROL_SCHEMA,
    BACKGROUND_WORKFLOW_VERSION,
    type BackgroundWorkflowEventV1,
    parseBackgroundWorkflowControl,
    parseBackgroundWorkflowControlResult,
    parseBackgroundWorkflowEvent,
    type WorkflowControlAction,
} from "../extensions/workflow/background-protocol.js";
import type { WorkflowRunSummaryV1 } from "../extensions/workflow/protocol.js";

export type { WorkflowControlAction, WorkflowRunSummaryV1 };

const MAX_WORKFLOW_RUNS = 100;
const CONTROL_TIMEOUT_MS = 5_000;

export interface WorkflowState {
    instanceId?: string;
    /** A validated reset permits the producer's replacement instance to establish authority. */
    acceptingInstance?: true;
    runs: ReadonlyMap<string, WorkflowRunSummaryV1>;
}

/** Reduce authoritative snapshots without mutating the prior map or accepted runs. */
export function reduceWorkflowEvent(
    state: WorkflowState,
    event: BackgroundWorkflowEventV1,
    route: { sessionId: string; cwd: string },
): WorkflowState {
    if (event.sessionId !== route.sessionId || event.cwd !== route.cwd) return state;
    if (event.type === "ready") {
        if (state.instanceId !== undefined && state.instanceId !== event.instanceId && !state.acceptingInstance)
            return state;
        return state.instanceId === event.instanceId && !state.acceptingInstance
            ? state
            : { instanceId: event.instanceId, runs: new Map() };
    }
    if (event.type === "reset") {
        if (event.instanceId !== state.instanceId) return state;
        return { instanceId: state.instanceId, acceptingInstance: true, runs: new Map() };
    }
    if (state.acceptingInstance || event.instanceId !== state.instanceId) return state;
    const runs = new Map(state.runs);
    if (event.type === "upsert" && event.run) {
        if (!runs.has(event.run.id) && runs.size >= MAX_WORKFLOW_RUNS) return state;
        runs.set(event.run.id, event.run);
    }
    return {
        instanceId: event.instanceId,
        ...(state.acceptingInstance ? { acceptingInstance: true as const } : {}),
        runs,
    };
}

export interface WorkflowBridgeOptions {
    eventBus: EventBusController;
    /** Invoked whenever the observed run set changes. */
    onChange: () => void;
    controlTimeoutMs?: number;
}

/**
 * The host's view of workflow runs: consumes the extension's background events into
 * an immutable run map and turns control requests into validated bus round-trips.
 */
export class WorkflowBridge {
    private state: WorkflowState = { runs: new Map() };
    private sessionId = "";
    private cwd = "";
    private unsubscribe?: () => void;
    private readonly pendingControls = new Set<(error: Error) => void>();

    constructor(private readonly options: WorkflowBridgeOptions) {}

    /** Follow a session; discards prior runs and rejects in-flight control requests. */
    bind(sessionId: string, cwd: string): void {
        this.rejectPending(new Error("Workflow session changed."));
        this.unsubscribe?.();
        this.state = { runs: new Map() };
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.unsubscribe = this.options.eventBus.on(BACKGROUND_WORKFLOW_CHANNEL, (payload) => {
            const route = { sessionId: this.sessionId, cwd: this.cwd };
            const event = parseBackgroundWorkflowEvent(payload, route);
            if (!event) return;
            const next = reduceWorkflowEvent(this.state, event, route);
            if (next === this.state) return;
            this.state = next;
            this.options.onChange();
        });
    }

    runs(): WorkflowRunSummaryV1[] {
        return [...this.state.runs.values()];
    }

    inspect(runId: string): WorkflowRunSummaryV1 | undefined {
        return this.state.runs.get(runId);
    }

    /** Resolves with a linked run id (for retries) once the extension acknowledges the control. */
    control(runId: string, action: WorkflowControlAction, agentId?: string): Promise<string | undefined> {
        const run = this.state.runs.get(runId);
        const instanceId = this.state.instanceId;
        if (!run || !instanceId) return Promise.reject(new Error("Workflow control is unavailable."));
        if (action === "restart-agent" && !run.agents.some((agent) => agent.id === agentId))
            return Promise.reject(new Error("Workflow agent is unavailable."));
        const requestId = crypto.randomUUID();
        const route = { sessionId: this.sessionId, instanceId, cwd: this.cwd };
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;
            const cleanup = () => {
                clearTimeout(timer);
                unsubscribe();
                this.pendingControls.delete(cancel);
            };
            const cancel = (error: Error) => {
                cleanup();
                reject(error);
            };
            this.pendingControls.add(cancel);
            const unsubscribe = this.options.eventBus.on(BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL, (payload) => {
                const result = parseBackgroundWorkflowControlResult(payload, route);
                if (!result || result.requestId !== requestId) return;
                cleanup();
                result.ok ? resolve(result.linkedRunId) : reject(new Error(result.error ?? "Workflow control failed."));
            });
            timer = setTimeout(
                () => cancel(new Error("Workflow control request timed out.")),
                this.options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS,
            );
            const control = parseBackgroundWorkflowControl(
                {
                    schema: BACKGROUND_WORKFLOW_CONTROL_SCHEMA,
                    version: BACKGROUND_WORKFLOW_VERSION,
                    sessionId: this.sessionId,
                    instanceId,
                    cwd: this.cwd,
                    requestId,
                    runId,
                    action,
                    ...(agentId === undefined ? {} : { agentId }),
                },
                route,
            );
            if (!control) return cancel(new Error("Invalid workflow control request."));
            this.options.eventBus.emit(BACKGROUND_WORKFLOW_CONTROL_CHANNEL, control);
        });
    }

    dispose(): void {
        this.rejectPending(new Error("Controller disposed."));
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.state = { runs: new Map() };
    }

    private rejectPending(error: Error): void {
        for (const reject of this.pendingControls) reject(error);
        this.pendingControls.clear();
    }
}
