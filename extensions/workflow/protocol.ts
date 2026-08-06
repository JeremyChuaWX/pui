import { isRecord } from "../shared/validate.js";

export { boundedString as truncateWorkflowText, errorMessage } from "../shared/validate.js";

export const WORKFLOW_SCHEMA = "pi.workflow" as const;
export const WORKFLOW_PROTOCOL_VERSION = 1 as const;
export const MAX_WORKFLOW_PHASES = 100;
export const MAX_WORKFLOW_AGENTS = 1_000;
export const MAX_WORKFLOW_ACTIVITY = 20;
export const MAX_WORKFLOW_ID = 256;
export const MAX_WORKFLOW_NAME = 512;
export const MAX_WORKFLOW_DETAIL = 16_000;
export const MAX_WORKFLOW_PROMPT = 8_000;
export const MAX_WORKFLOW_DIAGNOSTIC = 2_000;

export type WorkflowEntrypoint = "script" | "function";
export type WorkflowRunStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
export type WorkflowPhaseStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type WorkflowAgentStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type WorkflowActivityKind = "agent" | "tool" | "log" | "diagnostic";

export interface WorkflowUsageV1 {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    turns: number;
}

export interface WorkflowLimitsV1 {
    maxConcurrency: number;
    maxAgents: number;
    timeoutMs: number;
    maxTokens: number;
    maxCost: number;
}

export interface WorkflowActivityV1 {
    sequence: number;
    timestamp: number;
    kind: WorkflowActivityKind;
    title: string;
    isError?: boolean;
}

export interface WorkflowAgentSummaryV1 {
    id: string;
    label: string;
    role: string;
    model?: string;
    status: WorkflowAgentStatus;
    phaseId?: string;
    startedAt?: number;
    updatedAt: number;
    endedAt?: number;
    usage: WorkflowUsageV1;
    prompt?: string;
    error?: string;
    worktree?: { cwd: string; branch: string };
    recentActivity: WorkflowActivityV1[];
}

export interface WorkflowPhaseSummaryV1 {
    id: string;
    name: string;
    status: WorkflowPhaseStatus;
    startedAt?: number;
    updatedAt: number;
    endedAt?: number;
    agentIds: string[];
    error?: string;
}

export interface WorkflowRunSummaryV1 {
    schema: typeof WORKFLOW_SCHEMA;
    version: typeof WORKFLOW_PROTOCOL_VERSION;
    id: string;
    name: string;
    sessionId: string;
    cwd: string;
    status: WorkflowRunStatus;
    currentPhase?: string;
    phases: WorkflowPhaseSummaryV1[];
    agents: WorkflowAgentSummaryV1[];
    usage: WorkflowUsageV1;
    limits: WorkflowLimitsV1;
    recentActivity: WorkflowActivityV1[];
    startedAt?: number;
    updatedAt: number;
    endedAt?: number;
    warning?: string;
    error?: string;
}

export interface WorkflowRunDetailsV1 {
    schema: typeof WORKFLOW_SCHEMA;
    version: typeof WORKFLOW_PROTOCOL_VERSION;
    run: WorkflowRunSummaryV1;
    script?: string;
    result?: string;
}

const RUN_STATUSES = new Set<WorkflowRunStatus>(["queued", "running", "paused", "succeeded", "failed", "cancelled"]);
const PHASE_STATUSES = new Set<WorkflowPhaseStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);
const AGENT_STATUSES = new Set<WorkflowAgentStatus>([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
]);
const ACTIVITY_KINDS = new Set<WorkflowActivityKind>(["agent", "tool", "log", "diagnostic"]);

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
    return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
function string(value: unknown, maximum: number, required = true): value is string {
    return typeof value === "string" && value.length <= maximum && (!required || value.length > 0);
}
function optionalString(value: unknown, maximum: number): boolean {
    return value === undefined || string(value, maximum, false);
}
function timestamp(value: unknown): boolean {
    return value === undefined || finite(value);
}

function usage(value: unknown): value is WorkflowUsageV1 {
    if (!isRecord(value)) return false;
    return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "turns"].every((key) =>
        finite(value[key]),
    );
}
function limits(value: unknown): value is WorkflowLimitsV1 {
    if (!isRecord(value)) return false;
    return (
        integer(value.maxConcurrency, 16) &&
        (value.maxConcurrency as number) > 0 &&
        integer(value.maxAgents, MAX_WORKFLOW_AGENTS) &&
        (value.maxAgents as number) > 0 &&
        finite(value.timeoutMs) &&
        finite(value.maxTokens) &&
        finite(value.maxCost)
    );
}
function activities(value: unknown): value is WorkflowActivityV1[] {
    if (!Array.isArray(value) || value.length > MAX_WORKFLOW_ACTIVITY) return false;
    let sequence = -1;
    return value.every((item) => {
        if (
            !isRecord(item) ||
            !integer(item.sequence) ||
            (item.sequence as number) <= sequence ||
            !finite(item.timestamp) ||
            !string(item.kind, 32) ||
            !ACTIVITY_KINDS.has(item.kind as WorkflowActivityKind) ||
            !string(item.title, MAX_WORKFLOW_DIAGNOSTIC, false) ||
            (item.isError !== undefined && typeof item.isError !== "boolean")
        )
            return false;
        sequence = item.sequence as number;
        return true;
    });
}
function agent(value: unknown): value is WorkflowAgentSummaryV1 {
    if (!isRecord(value)) return false;
    return (
        string(value.id, MAX_WORKFLOW_ID) &&
        string(value.label, MAX_WORKFLOW_NAME) &&
        string(value.role, 128) &&
        optionalString(value.model, 256) &&
        string(value.status, 32) &&
        AGENT_STATUSES.has(value.status as WorkflowAgentStatus) &&
        optionalString(value.phaseId, MAX_WORKFLOW_ID) &&
        timestamp(value.startedAt) &&
        finite(value.updatedAt) &&
        timestamp(value.endedAt) &&
        usage(value.usage) &&
        optionalString(value.prompt, MAX_WORKFLOW_PROMPT) &&
        optionalString(value.error, MAX_WORKFLOW_DETAIL) &&
        (value.worktree === undefined ||
            (isRecord(value.worktree) &&
                string(value.worktree.cwd, MAX_WORKFLOW_DETAIL) &&
                string(value.worktree.branch, MAX_WORKFLOW_DETAIL))) &&
        activities(value.recentActivity)
    );
}
function phase(value: unknown): value is WorkflowPhaseSummaryV1 {
    if (!isRecord(value)) return false;
    return (
        string(value.id, MAX_WORKFLOW_ID) &&
        string(value.name, MAX_WORKFLOW_NAME) &&
        string(value.status, 32) &&
        PHASE_STATUSES.has(value.status as WorkflowPhaseStatus) &&
        timestamp(value.startedAt) &&
        finite(value.updatedAt) &&
        timestamp(value.endedAt) &&
        Array.isArray(value.agentIds) &&
        value.agentIds.length <= MAX_WORKFLOW_AGENTS &&
        value.agentIds.every((id) => string(id, MAX_WORKFLOW_ID)) &&
        optionalString(value.error, MAX_WORKFLOW_DETAIL)
    );
}

/** Strict wire parser. Unknown versions return undefined so callers retain generic rendering. */
export function parseWorkflowRunV1(value: unknown): WorkflowRunSummaryV1 | undefined {
    if (!isRecord(value) || value.schema !== WORKFLOW_SCHEMA || value.version !== WORKFLOW_PROTOCOL_VERSION)
        return undefined;
    if (
        !string(value.id, MAX_WORKFLOW_ID) ||
        !string(value.name, MAX_WORKFLOW_NAME) ||
        !string(value.sessionId, MAX_WORKFLOW_ID) ||
        !string(value.cwd, 4_000) ||
        !string(value.status, 32) ||
        !RUN_STATUSES.has(value.status as WorkflowRunStatus) ||
        !optionalString(value.currentPhase, MAX_WORKFLOW_ID) ||
        !Array.isArray(value.phases) ||
        value.phases.length > MAX_WORKFLOW_PHASES ||
        !value.phases.every(phase) ||
        !Array.isArray(value.agents) ||
        value.agents.length > MAX_WORKFLOW_AGENTS ||
        !value.agents.every(agent) ||
        !usage(value.usage) ||
        !limits(value.limits) ||
        !activities(value.recentActivity) ||
        !timestamp(value.startedAt) ||
        !finite(value.updatedAt) ||
        !timestamp(value.endedAt) ||
        !optionalString(value.warning, MAX_WORKFLOW_DIAGNOSTIC) ||
        !optionalString(value.error, MAX_WORKFLOW_DETAIL)
    )
        return undefined;
    const ids = new Set((value.agents as WorkflowAgentSummaryV1[]).map((item) => item.id));
    if (ids.size !== value.agents.length) return undefined;
    if ((value.phases as WorkflowPhaseSummaryV1[]).some((item) => item.agentIds.some((id) => !ids.has(id))))
        return undefined;
    return value as unknown as WorkflowRunSummaryV1;
}

export function parseWorkflowDetailsV1(value: unknown): WorkflowRunDetailsV1 | undefined {
    if (!isRecord(value) || value.schema !== WORKFLOW_SCHEMA || value.version !== WORKFLOW_PROTOCOL_VERSION)
        return undefined;
    const run = parseWorkflowRunV1(value.run);
    if (
        !run ||
        !optionalString(value.script, MAX_WORKFLOW_DETAIL) ||
        !optionalString(value.result, MAX_WORKFLOW_DETAIL)
    )
        return undefined;
    return {
        schema: WORKFLOW_SCHEMA,
        version: WORKFLOW_PROTOCOL_VERSION,
        run,
        ...(value.script === undefined ? {} : { script: value.script as string }),
        ...(value.result === undefined ? {} : { result: value.result as string }),
    };
}

export const BACKGROUND_WORKFLOW_CHANNEL = "pui.workflow.background" as const;
export const BACKGROUND_WORKFLOW_CONTROL_CHANNEL = "pui.workflow.background.control" as const;
export const BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL = "pui.workflow.background.control.result" as const;
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
    type: "ready" | "reset" | "upsert";
    run?: WorkflowRunSummaryV1;
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

export interface WorkflowRoute {
    sessionId: string;
    instanceId?: string;
    /** Already-canonical cwd. Protocol parsing deliberately performs exact routing only. */
    cwd: string;
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
        !isRecord(value) ||
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
    return undefined;
}

export function parseBackgroundWorkflowControl(
    value: unknown,
    route?: WorkflowRoute,
): BackgroundWorkflowControlV1 | undefined {
    if (
        !isRecord(value) ||
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
        !isRecord(value) ||
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
