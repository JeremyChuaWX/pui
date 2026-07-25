export const SUBAGENT_SCHEMA = "pi.subagent" as const;
export const SUBAGENT_PROTOCOL_VERSION = 1 as const;
export const MAX_SUBAGENT_ACTIVITY = 20;
/** Compatibility mirror of extensions/subagent/protocol.ts; host code stays extension-runtime independent. */
export const MAX_SUBAGENT_ACTIVE_TOOLS = 64;

export type SubagentStatus = "queued" | "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type SubagentPhase = "queued" | "spawning" | "thinking" | "tool" | "exiting";
export type SubagentActivityKind = "turn" | "tool_start" | "tool_end" | "assistant" | "diagnostic";

export interface SubagentActiveTool {
    id: string;
    name: string;
    title: string;
    startedAt: number;
}

export interface SubagentActivity {
    sequence: number;
    timestamp: number;
    kind: SubagentActivityKind;
    title: string;
    isError?: boolean;
}

export interface SubagentUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    turns: number;
}

export interface SubagentViewModel {
    source: "protocol-v1" | "legacy";
    id: string;
    agent: string;
    model: string;
    cwd: string;
    status: SubagentStatus;
    phase?: SubagentPhase;
    startedAt?: number;
    updatedAt: number;
    endedAt?: number;
    activeTools: SubagentActiveTool[];
    recentActivity: SubagentActivity[];
    usage: SubagentUsage;
    outputPreview?: string;
    error?: string;
    fullOutputPath?: string;
    prompt?: string;
}

export interface NormalizeSubagentOptions {
    toolCallId?: string;
    args?: Record<string, unknown>;
    running?: boolean;
    isError?: boolean;
    timestamp?: number;
    startedAt?: number;
    error?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function bounded(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function optionalString(value: unknown, max: number): string | undefined | false {
    if (value === undefined) return undefined;
    return typeof value === "string" ? bounded(value, max) : false;
}

function parseUsage(value: unknown, legacy = false): SubagentUsage | undefined {
    if (!isRecord(value)) return undefined;
    const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
    if (fields.some((field) => !isFiniteNonNegative(value[field]))) return undefined;
    const turns = value.turns;
    if (!legacy && !isFiniteNonNegative(turns)) return undefined;
    if (legacy && turns !== undefined && !isFiniteNonNegative(turns)) return undefined;
    return {
        input: value.input as number,
        output: value.output as number,
        cacheRead: value.cacheRead as number,
        cacheWrite: value.cacheWrite as number,
        totalTokens: value.totalTokens as number,
        cost: value.cost as number,
        turns: (turns as number | undefined) ?? 0,
    };
}

function promptFromOptions(options: NormalizeSubagentOptions): string | undefined {
    const prompt = options.args?.prompt;
    return typeof prompt === "string" ? bounded(prompt, 8_000) : undefined;
}

function parseProtocolV1(
    value: Record<string, unknown>,
    options: NormalizeSubagentOptions,
): SubagentViewModel | undefined {
    if (value.schema !== SUBAGENT_SCHEMA || value.version !== SUBAGENT_PROTOCOL_VERSION || !isRecord(value.run)) {
        return undefined;
    }
    const run = value.run;
    if (
        typeof run.id !== "string" ||
        (options.toolCallId !== undefined && run.id !== options.toolCallId) ||
        typeof run.agent !== "string" ||
        typeof run.model !== "string" ||
        typeof run.cwd !== "string" ||
        typeof run.status !== "string" ||
        !STATUSES.has(run.status as SubagentStatus) ||
        !isFiniteNonNegative(run.updatedAt)
    ) {
        return undefined;
    }
    if (run.phase !== undefined && (typeof run.phase !== "string" || !PHASES.has(run.phase as SubagentPhase))) {
        return undefined;
    }
    if (run.startedAt !== undefined && !isFiniteNonNegative(run.startedAt)) return undefined;
    if (run.endedAt !== undefined && !isFiniteNonNegative(run.endedAt)) return undefined;
    if (TERMINAL_STATUSES.has(run.status as SubagentStatus) && run.endedAt === undefined) return undefined;
    if (!Array.isArray(run.activeTools) || run.activeTools.length > MAX_SUBAGENT_ACTIVE_TOOLS) return undefined;
    if (!Array.isArray(run.recentActivity) || run.recentActivity.length > MAX_SUBAGENT_ACTIVITY) return undefined;
    if (TERMINAL_STATUSES.has(run.status as SubagentStatus) && run.activeTools.length > 0) return undefined;

    const activeTools: SubagentActiveTool[] = [];
    for (const tool of run.activeTools) {
        if (
            !isRecord(tool) ||
            typeof tool.id !== "string" ||
            typeof tool.name !== "string" ||
            typeof tool.title !== "string" ||
            !isFiniteNonNegative(tool.startedAt)
        ) {
            return undefined;
        }
        activeTools.push({
            id: bounded(tool.id, 256),
            name: bounded(tool.name, 256),
            title: bounded(tool.title, 2_000),
            startedAt: tool.startedAt,
        });
    }

    const recentActivity: SubagentActivity[] = [];
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
            return undefined;
        }
        previousSequence = activity.sequence as number;
        recentActivity.push({
            sequence: activity.sequence as number,
            timestamp: activity.timestamp,
            kind: activity.kind as SubagentActivityKind,
            title: bounded(activity.title, 2_000),
            ...(activity.isError === undefined ? {} : { isError: activity.isError }),
        });
    }

    const usage = parseUsage(run.usage);
    if (!usage) return undefined;
    const outputPreview = optionalString(run.outputPreview, 16_000);
    const error = optionalString(run.error, 16_000);
    const fullOutputPath = optionalString(run.fullOutputPath, 4_000);
    if (outputPreview === false || error === false || fullOutputPath === false) return undefined;

    return {
        source: "protocol-v1",
        id: bounded(run.id, 256),
        agent: bounded(run.agent, 128),
        model: bounded(run.model, 256),
        cwd: bounded(run.cwd, 4_000),
        status: run.status as SubagentStatus,
        ...(run.phase === undefined ? {} : { phase: run.phase as SubagentPhase }),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        updatedAt: run.updatedAt,
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        activeTools,
        recentActivity,
        usage,
        ...(outputPreview === undefined ? {} : { outputPreview }),
        ...(error === undefined ? {} : { error }),
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
        ...(promptFromOptions(options) === undefined ? {} : { prompt: promptFromOptions(options) }),
    };
}

function parseLegacy(value: Record<string, unknown>, options: NormalizeSubagentOptions): SubagentViewModel | undefined {
    if (
        value.schema !== undefined ||
        typeof value.agent !== "string" ||
        (value.model !== undefined && typeof value.model !== "string") ||
        !Array.isArray(value.toolCalls) ||
        value.toolCalls.length > MAX_SUBAGENT_ACTIVITY ||
        value.toolCalls.some((tool) => typeof tool !== "string")
    ) {
        return undefined;
    }
    const usage = parseUsage(value.usage, true);
    if (!usage) return undefined;
    const fullOutputPath = optionalString(value.fullOutputPath, 4_000);
    if (fullOutputPath === false) return undefined;

    const timestamp = options.timestamp ?? options.startedAt ?? 0;
    const running = options.running === true;
    const status: SubagentStatus = running ? "running" : options.isError ? "failed" : "succeeded";
    const toolCalls = value.toolCalls as string[];
    return {
        source: "legacy",
        id: bounded(options.toolCallId ?? "legacy-subagent", 256),
        agent: bounded(value.agent, 128),
        model: bounded((value.model as string | undefined) ?? String(options.args?.model ?? "default"), 256),
        cwd: bounded(typeof options.args?.cwd === "string" ? options.args.cwd : "", 4_000),
        status,
        phase: running ? (toolCalls.length > 0 ? "tool" : "thinking") : "exiting",
        ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
        updatedAt: timestamp,
        ...(running ? {} : { endedAt: timestamp }),
        activeTools: [],
        recentActivity: toolCalls.map((title, index) => ({
            sequence: index + 1,
            timestamp,
            kind: "tool_end" as const,
            title: bounded(title, 2_000),
        })),
        usage,
        ...(options.isError && options.error ? { error: bounded(options.error, 16_000) } : {}),
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
        ...(promptFromOptions(options) === undefined ? {} : { prompt: promptFromOptions(options) }),
    };
}

/** Normalize protocol details without importing or trusting extension-owned code. */
export function normalizeSubagentDetails(
    value: unknown,
    options: NormalizeSubagentOptions = {},
): SubagentViewModel | undefined {
    if (!isRecord(value)) return undefined;
    if (value.schema !== undefined || value.version !== undefined) return parseProtocolV1(value, options);
    return parseLegacy(value, options);
}

export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}

export function subagentStatusIcon(status: SubagentStatus): string {
    switch (status) {
        case "succeeded":
            return "✓";
        case "failed":
            return "×";
        case "cancelled":
            return "⊘";
        case "timed_out":
            return "⧖";
        case "queued":
            return "○";
        case "starting":
        case "running":
            return "◌";
    }
}

export function subagentStatusLabel(status: SubagentStatus): string {
    return status === "timed_out" ? "timed out" : status.replace("_", " ");
}

export function formatElapsed(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

export function subagentElapsed(view: SubagentViewModel, now = Date.now()): string {
    const start = view.startedAt ?? view.updatedAt;
    const end = view.endedAt ?? now;
    return formatElapsed(Math.max(0, end - start));
}

export function compactSubagentUsage(usage: SubagentUsage): string {
    const parts: string[] = [];
    if (usage.turns > 0) parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
    if (usage.totalTokens > 0) parts.push(`${compactCount(usage.totalTokens)} tokens`);
    return parts.join(" · ");
}

function compactCount(value: number): string {
    if (value < 1_000) return String(value);
    if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
    return `${(value / 1_000_000).toFixed(1)}m`;
}

export function subagentSummary(view: SubagentViewModel, now = Date.now()): string {
    const parts = [view.agent];
    if (view.model) parts.push(view.model);
    if (view.status === "failed" || view.status === "cancelled" || view.status === "timed_out") {
        parts.push(subagentStatusLabel(view.status));
    } else if (!isTerminalSubagentStatus(view.status)) {
        parts.push(subagentStatusLabel(view.status));
    }
    parts.push(subagentElapsed(view, now));
    const usage = compactSubagentUsage(view.usage);
    if (usage) parts.push(usage);
    return parts.join(" · ");
}

/** A bounded key used by display reconciliation instead of opaque extension details. */
export function subagentPresentationKey(view: SubagentViewModel): string {
    return JSON.stringify(view);
}
