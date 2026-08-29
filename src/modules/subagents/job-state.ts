import { isRecord } from "#shared/lib/validate.js";

export const MAX_RECENT_ACTIVITY = 20;
export const MAX_SUBAGENT_ACTIVE_TOOLS = 64;

export type SubagentStatus =
    | "queued"
    | "starting"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "stalled"
    | "tool_stalled";

export type SubagentPhase = "queued" | "spawning" | "thinking" | "tool" | "exiting";
export type SubagentActivityKind = "turn" | "tool_start" | "tool_end" | "assistant" | "diagnostic";
/** A Limit ends a Job as `timed_out` (wall clock), `stalled` (stall), or `tool_stalled` (tool stall). */
export type SubagentTerminalStatus = Extract<
    SubagentStatus,
    "succeeded" | "failed" | "cancelled" | "timed_out" | "stalled" | "tool_stalled"
>;

export interface SubagentActiveToolV1 {
    id: string;
    name: string;
    title: string;
    startedAt: number;
}

export interface SubagentActivityV1 {
    sequence: number;
    timestamp: number;
    kind: SubagentActivityKind;
    title: string;
    isError?: boolean;
}

export interface SubagentUsageV1 {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    turns: number;
}

/** The state of one Job. A Job carries one of these on the Background Protocol. */
export interface SubagentJobV1 {
    id: string;
    agent: string;
    model: string;
    cwd: string;
    status: SubagentStatus;
    phase?: SubagentPhase;
    startedAt?: number;
    updatedAt: number;
    endedAt?: number;
    activeTools: SubagentActiveToolV1[];
    recentActivity: SubagentActivityV1[];
    usage: SubagentUsageV1;
    outputPreview?: string;
    error?: string;
    fullOutputPath?: string;
}

interface CreateSubagentJobInput {
    id: string;
    agent: string;
    model: string;
    cwd: string;
    now: number;
}

type SubagentJobPatch = Partial<
    Omit<SubagentJobV1, "id" | "updatedAt" | "activeTools" | "recentActivity" | "usage">
> & {
    activeTools?: SubagentActiveToolV1[];
    recentActivity?: SubagentActivityV1[];
    usage?: SubagentUsageV1;
};

interface SubagentTerminalPatch {
    status: SubagentTerminalStatus;
    error?: string;
    outputPreview?: string;
    fullOutputPath?: string;
    model?: string;
}

const STATUSES = new Set<SubagentStatus>([
    "queued",
    "starting",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "stalled",
    "tool_stalled",
]);
const TERMINAL_STATUSES = new Set<SubagentStatus>([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "stalled",
    "tool_stalled",
]);
const PHASES = new Set<SubagentPhase>(["queued", "spawning", "thinking", "tool", "exiting"]);
const ACTIVITY_KINDS = new Set<SubagentActivityKind>(["turn", "tool_start", "tool_end", "assistant", "diagnostic"]);

export function emptySubagentUsage(): SubagentUsageV1 {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        turns: 0,
    };
}

export function isTerminalSubagentStatus(status: SubagentStatus): status is SubagentTerminalStatus {
    return TERMINAL_STATUSES.has(status);
}

export function createInitialSubagentJob(input: CreateSubagentJobInput): SubagentJobV1 {
    const now = input.now;
    return {
        id: input.id,
        agent: input.agent,
        model: input.model,
        cwd: input.cwd,
        status: "queued",
        phase: "queued",
        updatedAt: now,
        activeTools: [],
        recentActivity: [],
        usage: emptySubagentUsage(),
    };
}

export function updateSubagentJob(previous: SubagentJobV1, patch: SubagentJobPatch, now: number): SubagentJobV1 {
    const status = patch.status ?? previous.status;
    const terminal = isTerminalSubagentStatus(status);
    const job: SubagentJobV1 = {
        ...previous,
        ...patch,
        id: previous.id,
        status,
        updatedAt: now,
        activeTools: terminal ? [] : [...(patch.activeTools ?? previous.activeTools)].slice(-MAX_SUBAGENT_ACTIVE_TOOLS),
        recentActivity: [...(patch.recentActivity ?? previous.recentActivity)].slice(-MAX_RECENT_ACTIVITY),
        usage: { ...(patch.usage ?? previous.usage) },
    };

    if (terminal) {
        job.phase = "exiting";
        job.endedAt = patch.endedAt ?? previous.endedAt ?? now;
    } else {
        delete job.endedAt;
    }

    return job;
}

export function createTerminalSubagentJob(
    previous: SubagentJobV1,
    patch: SubagentTerminalPatch,
    now: number,
): SubagentJobV1 {
    return updateSubagentJob(
        previous,
        {
            ...patch,
            phase: "exiting",
            endedAt: now,
            activeTools: [],
        },
        now,
    );
}

export function appendSubagentActivity(
    previous: SubagentJobV1,
    activity: Omit<SubagentActivityV1, "sequence"> & { sequence?: number },
    now = activity.timestamp,
): SubagentJobV1 {
    const last = previous.recentActivity.at(-1)?.sequence ?? 0;
    const sequence = Math.max(last + 1, activity.sequence ?? 0);
    const next: SubagentActivityV1 = { ...activity, sequence };
    return updateSubagentJob(
        previous,
        { recentActivity: [...previous.recentActivity, next].slice(-MAX_RECENT_ACTIVITY) },
        now,
    );
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Structural validator for an untrusted Job state payload, used by the Background Protocol parser. */
export function isSubagentJobV1(job: unknown): job is SubagentJobV1 {
    if (!isRecord(job)) return false;
    if (
        typeof job.id !== "string" ||
        typeof job.agent !== "string" ||
        typeof job.model !== "string" ||
        typeof job.cwd !== "string" ||
        typeof job.status !== "string" ||
        !STATUSES.has(job.status as SubagentStatus) ||
        !isFiniteNonNegative(job.updatedAt)
    ) {
        return false;
    }
    if (job.phase !== undefined && (typeof job.phase !== "string" || !PHASES.has(job.phase as SubagentPhase)))
        return false;
    if (job.startedAt !== undefined && !isFiniteNonNegative(job.startedAt)) return false;
    if (job.endedAt !== undefined && !isFiniteNonNegative(job.endedAt)) return false;
    if (isTerminalSubagentStatus(job.status as SubagentStatus) && job.endedAt === undefined) return false;
    if (
        !Array.isArray(job.activeTools) ||
        job.activeTools.length > MAX_SUBAGENT_ACTIVE_TOOLS ||
        !Array.isArray(job.recentActivity) ||
        job.recentActivity.length > MAX_RECENT_ACTIVITY
    ) {
        return false;
    }
    if (isTerminalSubagentStatus(job.status as SubagentStatus) && job.activeTools.length > 0) return false;
    for (const tool of job.activeTools) {
        if (
            !isRecord(tool) ||
            typeof tool.id !== "string" ||
            typeof tool.name !== "string" ||
            typeof tool.title !== "string" ||
            !isFiniteNonNegative(tool.startedAt)
        ) {
            return false;
        }
    }
    let previousSequence = -1;
    for (const activity of job.recentActivity) {
        if (
            !isRecord(activity) ||
            !Number.isInteger(activity.sequence) ||
            (activity.sequence as number) <= previousSequence ||
            !isFiniteNonNegative(activity.timestamp) ||
            typeof activity.kind !== "string" ||
            !ACTIVITY_KINDS.has(activity.kind as SubagentActivityKind) ||
            typeof activity.title !== "string" ||
            (activity.isError !== undefined && typeof activity.isError !== "boolean")
        ) {
            return false;
        }
        previousSequence = activity.sequence as number;
    }
    if (!isRecord(job.usage)) return false;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "turns"] as const) {
        if (!isFiniteNonNegative(job.usage[field])) return false;
    }
    for (const field of ["outputPreview", "error", "fullOutputPath"] as const) {
        if (job[field] !== undefined && typeof job[field] !== "string") return false;
    }
    return true;
}
