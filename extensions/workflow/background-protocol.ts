import { parseWorkflowRunV1, type WorkflowRunSummaryV1 } from "./protocol.js";

export const BACKGROUND_WORKFLOW_CHANNEL = "pui.workflow.background" as const;
export const BACKGROUND_WORKFLOW_CONTROL_CHANNEL = "pui.workflow.background.control" as const;
export const BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL = "pui.workflow.background.control.result" as const;
export const BACKGROUND_WORKFLOW_SAVE_CHANNEL = "pui.workflow.background.save" as const;
export const BACKGROUND_WORKFLOW_SAVE_RESULT_CHANNEL = "pui.workflow.background.save.result" as const;
export const BACKGROUND_WORKFLOW_SCHEMA = "pi.workflow.background" as const;
export const BACKGROUND_WORKFLOW_CONTROL_SCHEMA = "pi.workflow.background.control" as const;
export const BACKGROUND_WORKFLOW_VERSION = 1 as const;
const MAX_ID = 256;
const MAX_CWD = 4_000;

export type WorkflowControlAction = "pause" | "resume" | "stop" | "restart-agent" | "retry";
const WORKFLOW_CONTROL_ACTIONS: ReadonlySet<WorkflowControlAction> = new Set([
    "pause",
    "resume",
    "stop",
    "restart-agent",
    "retry",
]);

export interface BackgroundWorkflowEventV1 {
    schema: typeof BACKGROUND_WORKFLOW_SCHEMA;
    version: typeof BACKGROUND_WORKFLOW_VERSION;
    sessionId: string;
    instanceId: string;
    cwd: string;
    type: "ready" | "reset" | "upsert" | "remove";
    run?: WorkflowRunSummaryV1;
    runId?: string;
}

export interface BackgroundWorkflowControlV1 {
    schema: typeof BACKGROUND_WORKFLOW_CONTROL_SCHEMA;
    version: typeof BACKGROUND_WORKFLOW_VERSION;
    sessionId: string;
    instanceId: string;
    cwd: string;
    requestId: string;
    runId: string;
    action: WorkflowControlAction;
    agentId?: string;
}
export interface BackgroundWorkflowControlResultV1 {
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

export interface BackgroundWorkflowSaveV1 {
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
export interface BackgroundWorkflowSaveResultV1 {
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

export interface WorkflowRoute {
    sessionId: string;
    instanceId?: string;
    /** Already-canonical cwd. Protocol parsing deliberately performs exact routing only. */
    cwd: string;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identity(value: unknown, maximum = MAX_ID): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function routed(value: Record<string, unknown>, route?: WorkflowRoute): boolean {
    if (!identity(value.sessionId) || !identity(value.instanceId) || !identity(value.cwd, MAX_CWD)) return false;
    return (
        !route ||
        (value.sessionId === route.sessionId &&
            value.cwd === route.cwd &&
            (route.instanceId === undefined || value.instanceId === route.instanceId))
    );
}

export function parseBackgroundWorkflowEvent(
    value: unknown,
    route?: WorkflowRoute,
): BackgroundWorkflowEventV1 | undefined {
    if (
        !record(value) ||
        value.schema !== BACKGROUND_WORKFLOW_SCHEMA ||
        value.version !== BACKGROUND_WORKFLOW_VERSION ||
        !routed(value, route)
    )
        return undefined;
    if (value.type === "ready" || value.type === "reset") {
        if (value.run !== undefined || value.runId !== undefined) return undefined;
        return value as unknown as BackgroundWorkflowEventV1;
    }
    if (value.type === "upsert") {
        if (value.runId !== undefined) return undefined;
        const run = parseWorkflowRunV1(value.run);
        if (!run || run.sessionId !== value.sessionId || run.cwd !== value.cwd) return undefined;
        return { ...(value as unknown as BackgroundWorkflowEventV1), run };
    }
    if (value.type === "remove" && identity(value.runId) && value.run === undefined)
        return value as unknown as BackgroundWorkflowEventV1;
    return undefined;
}

export function parseBackgroundWorkflowSave(
    value: unknown,
    route?: WorkflowRoute,
): BackgroundWorkflowSaveV1 | undefined {
    if (
        !record(value) ||
        value.schema !== "pi.workflow.background.save" ||
        value.version !== 1 ||
        !routed(value, route) ||
        !identity(value.requestId) ||
        !identity(value.runId) ||
        (value.scope !== "project" && value.scope !== "personal") ||
        typeof value.overwrite !== "boolean"
    )
        return undefined;
    return value as unknown as BackgroundWorkflowSaveV1;
}

export function parseBackgroundWorkflowSaveResult(
    value: unknown,
    route?: WorkflowRoute,
): BackgroundWorkflowSaveResultV1 | undefined {
    if (
        !record(value) ||
        value.schema !== "pi.workflow.background.save.result" ||
        value.version !== 1 ||
        !routed(value, route) ||
        !identity(value.requestId) ||
        typeof value.ok !== "boolean"
    )
        return undefined;
    if (value.ok) {
        if (!identity(value.path, MAX_CWD) || value.error !== undefined || value.code !== undefined) return undefined;
    } else if (
        !identity(value.error, 2_000) ||
        value.path !== undefined ||
        (value.code !== undefined && value.code !== "overwrite_required")
    )
        return undefined;
    return value as unknown as BackgroundWorkflowSaveResultV1;
}

export function parseBackgroundWorkflowControl(
    value: unknown,
    route?: WorkflowRoute,
): BackgroundWorkflowControlV1 | undefined {
    if (
        !record(value) ||
        value.schema !== BACKGROUND_WORKFLOW_CONTROL_SCHEMA ||
        value.version !== BACKGROUND_WORKFLOW_VERSION ||
        !routed(value, route) ||
        !identity(value.requestId) ||
        !identity(value.runId) ||
        !WORKFLOW_CONTROL_ACTIONS.has(value.action as WorkflowControlAction)
    )
        return undefined;
    if (value.action === "restart-agent") {
        if (!identity(value.agentId)) return undefined;
    } else if (value.agentId !== undefined) return undefined;
    return value as unknown as BackgroundWorkflowControlV1;
}

export function parseBackgroundWorkflowControlResult(
    value: unknown,
    route?: WorkflowRoute,
): BackgroundWorkflowControlResultV1 | undefined {
    if (
        !record(value) ||
        value.schema !== "pi.workflow.background.control.result" ||
        value.version !== 1 ||
        !routed(value, route) ||
        !identity(value.requestId) ||
        typeof value.ok !== "boolean"
    )
        return undefined;
    if (
        value.ok
            ? value.error !== undefined || (value.linkedRunId !== undefined && !identity(value.linkedRunId))
            : !identity(value.error, 2_000) || value.linkedRunId !== undefined
    )
        return undefined;
    return value as unknown as BackgroundWorkflowControlResultV1;
}
