import { boundedString } from "../extensions/shared/validate.js";
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

/** A validated, string-bounded copy of a subagent run, safe for rendering and reconciliation. */
export interface SubagentViewModel extends SubagentRunV1 {
    prompt?: string;
}

export interface NormalizeSubagentOptions {
    toolCallId?: string;
    args?: Record<string, unknown>;
}

function boundedTool(tool: SubagentActiveToolV1): SubagentActiveToolV1 {
    return {
        id: boundedString(tool.id, 256),
        name: boundedString(tool.name, 256),
        title: boundedString(tool.title, 2_000),
        startedAt: tool.startedAt,
    };
}

function boundedActivity(activity: SubagentActivityV1): SubagentActivityV1 {
    return {
        sequence: activity.sequence,
        timestamp: activity.timestamp,
        kind: activity.kind,
        title: boundedString(activity.title, 2_000),
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
        id: boundedString(run.id, 256),
        agent: boundedString(run.agent, 128),
        model: boundedString(run.model, 256),
        cwd: boundedString(run.cwd, 4_000),
        status: run.status,
        ...(run.phase === undefined ? {} : { phase: run.phase }),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        updatedAt: run.updatedAt,
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        activeTools: run.activeTools.map(boundedTool),
        recentActivity: run.recentActivity.map(boundedActivity),
        usage: { ...run.usage },
        ...(run.outputPreview === undefined ? {} : { outputPreview: boundedString(run.outputPreview, 16_000) }),
        ...(run.error === undefined ? {} : { error: boundedString(run.error, 16_000) }),
        ...(run.fullOutputPath === undefined ? {} : { fullOutputPath: boundedString(run.fullOutputPath, 4_000) }),
        ...(typeof prompt === "string" ? { prompt: boundedString(prompt, 8_000) } : {}),
    };
}

/** A bounded key used by display reconciliation instead of opaque extension details. */
export function subagentPresentationKey(view: SubagentViewModel): string {
    return JSON.stringify(view);
}
