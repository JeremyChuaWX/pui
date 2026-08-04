import {
    isSubagentDetailsV1,
    isTerminalSubagentStatus,
    type SubagentActiveToolV1,
    type SubagentActivityV1,
    type SubagentRunV1,
    type SubagentStatus,
    type SubagentUsageV1,
} from "../extensions/subagent/protocol.js";

export type { SubagentStatus };
export { isTerminalSubagentStatus };
export type SubagentUsage = SubagentUsageV1;
export type SubagentActivity = SubagentActivityV1;

/** A validated, string-bounded copy of a subagent run, safe for rendering and reconciliation. */
export interface SubagentViewModel extends SubagentRunV1 {
    prompt?: string;
}

export interface NormalizeSubagentOptions {
    toolCallId?: string;
    args?: Record<string, unknown>;
}

function bounded(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function boundedTool(tool: SubagentActiveToolV1): SubagentActiveToolV1 {
    return {
        id: bounded(tool.id, 256),
        name: bounded(tool.name, 256),
        title: bounded(tool.title, 2_000),
        startedAt: tool.startedAt,
    };
}

function boundedActivity(activity: SubagentActivityV1): SubagentActivityV1 {
    return {
        sequence: activity.sequence,
        timestamp: activity.timestamp,
        kind: activity.kind,
        title: bounded(activity.title, 2_000),
        ...(activity.isError === undefined ? {} : { isError: activity.isError }),
    };
}

/** Validate tool details against the subagent protocol and bound every string for display. */
export function normalizeSubagentDetails(
    value: unknown,
    options: NormalizeSubagentOptions = {},
): SubagentViewModel | undefined {
    if (!isSubagentDetailsV1(value)) return undefined;
    const run = value.run;
    if (options.toolCallId !== undefined && run.id !== options.toolCallId) return undefined;
    const prompt = options.args?.prompt;
    return {
        id: bounded(run.id, 256),
        agent: bounded(run.agent, 128),
        model: bounded(run.model, 256),
        cwd: bounded(run.cwd, 4_000),
        status: run.status,
        ...(run.phase === undefined ? {} : { phase: run.phase }),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        updatedAt: run.updatedAt,
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        activeTools: run.activeTools.map(boundedTool),
        recentActivity: run.recentActivity.map(boundedActivity),
        usage: { ...run.usage },
        ...(run.outputPreview === undefined ? {} : { outputPreview: bounded(run.outputPreview, 16_000) }),
        ...(run.error === undefined ? {} : { error: bounded(run.error, 16_000) }),
        ...(run.fullOutputPath === undefined ? {} : { fullOutputPath: bounded(run.fullOutputPath, 4_000) }),
        ...(typeof prompt === "string" ? { prompt: bounded(prompt, 8_000) } : {}),
    };
}

/** A bounded key used by display reconciliation instead of opaque extension details. */
export function subagentPresentationKey(view: SubagentViewModel): string {
    return JSON.stringify(view);
}
