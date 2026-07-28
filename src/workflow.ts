export * from "../extensions/workflow/protocol.js";

import {
    MAX_WORKFLOW_DIAGNOSTIC,
    MAX_WORKFLOW_ID,
    parseWorkflowRunV1,
    type WorkflowRunSummaryV1,
} from "../extensions/workflow/protocol.js";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const BACKGROUND_WORKFLOW_CHANNEL = "pui.workflow.background" as const;
export const BACKGROUND_WORKFLOW_CONTROL_CHANNEL = "pui.workflow.background.control" as const;
export const BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL = "pui.workflow.background.control.result" as const;
export const BACKGROUND_WORKFLOW_SAVE_CHANNEL = "pui.workflow.background.save" as const;
export const BACKGROUND_WORKFLOW_SAVE_RESULT_CHANNEL = "pui.workflow.background.save.result" as const;
export const BACKGROUND_WORKFLOW_CONTROL_SCHEMA = "pi.workflow.background.control" as const;
const BACKGROUND_SCHEMA = "pi.workflow.background";
export type WorkflowControlAction = "pause" | "resume" | "stop" | "restart-agent" | "retry";

export interface WorkflowControlV1 {
    schema: typeof BACKGROUND_WORKFLOW_CONTROL_SCHEMA;
    version: 1;
    sessionId: string;
    instanceId: string;
    cwd: string;
    requestId: string;
    runId: string;
    action: WorkflowControlAction;
    agentId?: string;
}
export interface WorkflowControlResultV1 {
    schema: "pi.workflow.background.control.result";
    version: 1;
    sessionId: string;
    instanceId: string;
    cwd: string;
    requestId: string;
    ok: boolean;
    linkedRunId?: string;
    error?: string;
}
const MAX_WORKFLOW_RUNS = 100;

export type WorkflowBackgroundEvent =
    | { type: "ready" | "reset"; sessionId: string; instanceId: string; cwd: string }
    | { type: "upsert"; sessionId: string; instanceId: string; cwd: string; run: WorkflowRunSummaryV1 }
    | { type: "remove"; sessionId: string; instanceId: string; cwd: string; runId: string };

export interface WorkflowRouting {
    sessionId: string;
    cwd: string;
    instanceId?: string;
}

function routeIdentity(value: unknown, maximum = MAX_WORKFLOW_ID): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

/** Parse extension events with exact session and already-canonical cwd routing. */
export function parseWorkflowBackgroundEvent(
    value: unknown,
    route?: WorkflowRouting,
): WorkflowBackgroundEvent | undefined {
    if (
        !record(value) ||
        value.schema !== BACKGROUND_SCHEMA ||
        value.version !== 1 ||
        !routeIdentity(value.sessionId) ||
        !routeIdentity(value.instanceId) ||
        !routeIdentity(value.cwd, 4_000) ||
        (route !== undefined &&
            (value.sessionId !== route.sessionId ||
                value.cwd !== route.cwd ||
                (route.instanceId !== undefined && value.instanceId !== route.instanceId)))
    )
        return undefined;
    if (value.type === "ready" || value.type === "reset") {
        if (value.run !== undefined || value.runId !== undefined) return undefined;
        return { type: value.type, sessionId: value.sessionId, instanceId: value.instanceId, cwd: value.cwd };
    }
    if (value.type === "upsert") {
        if (value.runId !== undefined) return undefined;
        const run = parseWorkflowRunV1(value.run);
        if (!run || run.sessionId !== value.sessionId || run.cwd !== value.cwd) return undefined;
        return { type: "upsert", sessionId: value.sessionId, instanceId: value.instanceId, cwd: value.cwd, run };
    }
    if (value.type === "remove" && routeIdentity(value.runId) && value.run === undefined)
        return {
            type: "remove",
            sessionId: value.sessionId,
            instanceId: value.instanceId,
            cwd: value.cwd,
            runId: value.runId,
        };
    return undefined;
}

/** Independently validate controller controls before placing them on the event bus. */
export function parseWorkflowControl(value: unknown, route?: WorkflowRouting): WorkflowControlV1 | undefined {
    if (
        !record(value) ||
        value.schema !== BACKGROUND_WORKFLOW_CONTROL_SCHEMA ||
        value.version !== 1 ||
        !routeIdentity(value.sessionId) ||
        !routeIdentity(value.instanceId) ||
        !routeIdentity(value.cwd, 4_000) ||
        !routeIdentity(value.requestId) ||
        !routeIdentity(value.runId) ||
        !new Set<WorkflowControlAction>(["pause", "resume", "stop", "restart-agent", "retry"]).has(
            value.action as WorkflowControlAction,
        ) ||
        (route !== undefined &&
            (value.sessionId !== route.sessionId ||
                value.cwd !== route.cwd ||
                (route.instanceId !== undefined && value.instanceId !== route.instanceId)))
    )
        return undefined;
    if (value.action === "restart-agent") {
        if (!routeIdentity(value.agentId)) return undefined;
    } else if (value.agentId !== undefined) return undefined;
    return value as unknown as WorkflowControlV1;
}
export function parseWorkflowControlResult(
    value: unknown,
    route?: WorkflowRouting,
): WorkflowControlResultV1 | undefined {
    if (
        !record(value) ||
        value.schema !== "pi.workflow.background.control.result" ||
        value.version !== 1 ||
        !routeIdentity(value.sessionId) ||
        !routeIdentity(value.instanceId) ||
        !routeIdentity(value.cwd, 4_000) ||
        !routeIdentity(value.requestId) ||
        typeof value.ok !== "boolean" ||
        (route &&
            (value.sessionId !== route.sessionId ||
                value.cwd !== route.cwd ||
                (route.instanceId !== undefined && value.instanceId !== route.instanceId)))
    )
        return undefined;
    if (
        value.ok
            ? value.error !== undefined || (value.linkedRunId !== undefined && !routeIdentity(value.linkedRunId))
            : !routeIdentity(value.error, MAX_WORKFLOW_DIAGNOSTIC) || value.linkedRunId !== undefined
    )
        return undefined;
    return value as unknown as WorkflowControlResultV1;
}

export interface WorkflowSaveV1 {
    schema: "pi.workflow.background.save";
    version: 1;
    sessionId: string;
    instanceId: string;
    cwd: string;
    requestId: string;
    runId: string;
    scope: "project" | "personal";
    overwrite: boolean;
}
export interface WorkflowSaveResultV1 {
    schema: "pi.workflow.background.save.result";
    version: 1;
    sessionId: string;
    instanceId: string;
    cwd: string;
    requestId: string;
    ok: boolean;
    path?: string;
    error?: string;
    code?: "overwrite_required";
}
export function parseWorkflowSave(value: unknown, route?: WorkflowRouting): WorkflowSaveV1 | undefined {
    if (
        !record(value) ||
        value.schema !== "pi.workflow.background.save" ||
        value.version !== 1 ||
        !routeIdentity(value.sessionId) ||
        !routeIdentity(value.instanceId) ||
        !routeIdentity(value.cwd, 4_000) ||
        !routeIdentity(value.requestId) ||
        !routeIdentity(value.runId) ||
        (value.scope !== "project" && value.scope !== "personal") ||
        typeof value.overwrite !== "boolean" ||
        (route &&
            (value.sessionId !== route.sessionId ||
                value.cwd !== route.cwd ||
                (route.instanceId !== undefined && value.instanceId !== route.instanceId)))
    )
        return undefined;
    return value as unknown as WorkflowSaveV1;
}
export function parseWorkflowSaveResult(value: unknown, route?: WorkflowRouting): WorkflowSaveResultV1 | undefined {
    if (
        !record(value) ||
        value.schema !== "pi.workflow.background.save.result" ||
        value.version !== 1 ||
        !routeIdentity(value.sessionId) ||
        !routeIdentity(value.instanceId) ||
        !routeIdentity(value.cwd, 4_000) ||
        !routeIdentity(value.requestId) ||
        typeof value.ok !== "boolean" ||
        (route &&
            (value.sessionId !== route.sessionId ||
                value.cwd !== route.cwd ||
                (route.instanceId !== undefined && value.instanceId !== route.instanceId)))
    )
        return undefined;
    if (
        value.ok
            ? !routeIdentity(value.path, 4_000) || value.error !== undefined || value.code !== undefined
            : !routeIdentity(value.error, MAX_WORKFLOW_DIAGNOSTIC) ||
              value.path !== undefined ||
              (value.code !== undefined && value.code !== "overwrite_required")
    )
        return undefined;
    return value as unknown as WorkflowSaveResultV1;
}

export interface WorkflowState {
    instanceId?: string;
    /** A validated reset permits the producer's replacement instance to establish authority. */
    acceptingInstance?: true;
    runs: ReadonlyMap<string, WorkflowRunSummaryV1>;
}

/** Reduce authoritative snapshots without mutating the prior map or accepted runs. */
export function reduceWorkflowEvent(
    state: WorkflowState,
    event: WorkflowBackgroundEvent,
    route: Pick<WorkflowRouting, "sessionId" | "cwd">,
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
    if (event.instanceId !== state.instanceId) return state;
    const runs = new Map(state.runs);
    if (event.type === "upsert") {
        if (!runs.has(event.run.id) && runs.size >= MAX_WORKFLOW_RUNS) return state;
        runs.set(event.run.id, event.run);
    } else if (event.type === "remove") runs.delete(event.runId);
    return {
        instanceId: event.instanceId,
        ...(state.acceptingInstance ? { acceptingInstance: true as const } : {}),
        runs,
    };
}
