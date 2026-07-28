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

export type WorkflowRunStatus =
    | "awaiting_approval"
    | "queued"
    | "running"
    | "paused"
    | "succeeded"
    | "failed"
    | "cancelled";
export type WorkflowPhaseStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
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
    output?: string;
    error?: string;
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

/** Bound producer text at a Unicode code-point boundary; wire parsers reject unbounded input. */
export function truncateWorkflowText(value: string, maximum: number): string {
    const characters = Array.from(value);
    return characters.length <= maximum ? value : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

const RUN_STATUSES = new Set<WorkflowRunStatus>([
    "awaiting_approval",
    "queued",
    "running",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
]);
const PHASE_STATUSES = new Set<WorkflowPhaseStatus>([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "skipped",
]);
const AGENT_STATUSES = new Set<WorkflowAgentStatus>([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
]);
const ACTIVITY_KINDS = new Set<WorkflowActivityKind>(["agent", "tool", "log", "diagnostic"]);

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
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
    if (!record(value)) return false;
    return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "turns"].every((key) =>
        finite(value[key]),
    );
}
function limits(value: unknown): value is WorkflowLimitsV1 {
    if (!record(value)) return false;
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
            !record(item) ||
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
    if (!record(value)) return false;
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
        optionalString(value.output, MAX_WORKFLOW_DETAIL) &&
        optionalString(value.error, MAX_WORKFLOW_DETAIL) &&
        activities(value.recentActivity)
    );
}
function phase(value: unknown): value is WorkflowPhaseSummaryV1 {
    if (!record(value)) return false;
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
    if (!record(value) || value.schema !== WORKFLOW_SCHEMA || value.version !== WORKFLOW_PROTOCOL_VERSION)
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
    if (!record(value) || value.schema !== WORKFLOW_SCHEMA || value.version !== WORKFLOW_PROTOCOL_VERSION)
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
            ? !routeIdentity(value.path, 4_000) || value.error !== undefined
            : !routeIdentity(value.error, MAX_WORKFLOW_DIAGNOSTIC) || value.path !== undefined
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
    return { instanceId: event.instanceId, runs };
}
