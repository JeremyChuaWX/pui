import { isRecord } from "#shared/lib/validate.js";

export const MAX_RECENT_ACTIVITY = 20;
export const MAX_SUBAGENT_ACTIVE_TOOLS = 64;

export type SubagentStatus = "queued" | "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export type SubagentPhase = "queued" | "spawning" | "thinking" | "tool" | "exiting";
export type SubagentActivityKind = "turn" | "tool_start" | "tool_end" | "assistant" | "diagnostic";
export type SubagentTerminalStatus = Extract<SubagentStatus, "succeeded" | "failed" | "cancelled" | "timed_out">;

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

/** The state of one child run. A Job carries one of these on the Background Protocol. */
export interface SubagentRunV1 {
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

interface CreateSubagentRunInput {
    id: string;
    agent: string;
    model: string;
    cwd: string;
    now?: number;
}

type SubagentRunPatch = Partial<
    Omit<SubagentRunV1, "id" | "updatedAt" | "activeTools" | "recentActivity" | "usage">
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
]);
const TERMINAL_STATUSES = new Set<SubagentStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
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

export function createInitialSubagentRun(input: CreateSubagentRunInput): SubagentRunV1 {
    const now = input.now ?? Date.now();
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

export function updateSubagentRun(previous: SubagentRunV1, patch: SubagentRunPatch, now = Date.now()): SubagentRunV1 {
    const status = patch.status ?? previous.status;
    const terminal = isTerminalSubagentStatus(status);
    const run: SubagentRunV1 = {
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
        run.phase = "exiting";
        run.endedAt = patch.endedAt ?? previous.endedAt ?? now;
    } else {
        delete run.endedAt;
    }

    return run;
}

export function createTerminalSubagentRun(
    previous: SubagentRunV1,
    patch: SubagentTerminalPatch,
    now = Date.now(),
): SubagentRunV1 {
    return updateSubagentRun(
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
    previous: SubagentRunV1,
    activity: Omit<SubagentActivityV1, "sequence"> & { sequence?: number },
    now = activity.timestamp,
): SubagentRunV1 {
    const last = previous.recentActivity.at(-1)?.sequence ?? 0;
    const sequence = Math.max(last + 1, activity.sequence ?? 0);
    const next: SubagentActivityV1 = { ...activity, sequence };
    return updateSubagentRun(
        previous,
        { recentActivity: [...previous.recentActivity, next].slice(-MAX_RECENT_ACTIVITY) },
        now,
    );
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Structural validator for an untrusted run payload, used by the Background Protocol parser. */
export function isSubagentRunV1(run: unknown): run is SubagentRunV1 {
    if (!isRecord(run)) return false;
    if (
        typeof run.id !== "string" ||
        typeof run.agent !== "string" ||
        typeof run.model !== "string" ||
        typeof run.cwd !== "string" ||
        typeof run.status !== "string" ||
        !STATUSES.has(run.status as SubagentStatus) ||
        !isFiniteNonNegative(run.updatedAt)
    ) {
        return false;
    }
    if (run.phase !== undefined && (typeof run.phase !== "string" || !PHASES.has(run.phase as SubagentPhase)))
        return false;
    if (run.startedAt !== undefined && !isFiniteNonNegative(run.startedAt)) return false;
    if (run.endedAt !== undefined && !isFiniteNonNegative(run.endedAt)) return false;
    if (isTerminalSubagentStatus(run.status as SubagentStatus) && run.endedAt === undefined) return false;
    if (
        !Array.isArray(run.activeTools) ||
        run.activeTools.length > MAX_SUBAGENT_ACTIVE_TOOLS ||
        !Array.isArray(run.recentActivity) ||
        run.recentActivity.length > MAX_RECENT_ACTIVITY
    ) {
        return false;
    }
    if (isTerminalSubagentStatus(run.status as SubagentStatus) && run.activeTools.length > 0) return false;
    for (const tool of run.activeTools) {
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
    for (const activity of run.recentActivity) {
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
    if (!isRecord(run.usage)) return false;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "turns"] as const) {
        if (!isFiniteNonNegative(run.usage[field])) return false;
    }
    for (const field of ["outputPreview", "error", "fullOutputPath"] as const) {
        if (run[field] !== undefined && typeof run[field] !== "string") return false;
    }
    return true;
}
