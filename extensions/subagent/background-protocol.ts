import type { SubagentRunV1 } from "./protocol.js";

export const BACKGROUND_SUBAGENT_CHANNEL = "pui.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_CHANNEL = "pui.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_SCHEMA = "pi.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_SCHEMA = "pi.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_VERSION = 1 as const;
const MAX_CONTROL_ID = 256;

export interface BackgroundSubagentJobV1 {
    id: string;
    title: string;
    prompt?: string;
    run: SubagentRunV1;
}

export interface BackgroundSubagentControlV1 {
    schema: typeof BACKGROUND_SUBAGENT_CONTROL_SCHEMA;
    version: typeof BACKGROUND_SUBAGENT_VERSION;
    sessionId: string;
    instanceId: string;
    type: "cancel";
    jobId: string;
}

export function parseBackgroundSubagentControl(value: unknown): BackgroundSubagentControlV1 | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const control = value as Record<string, unknown>;
    if (
        control.schema !== BACKGROUND_SUBAGENT_CONTROL_SCHEMA ||
        control.version !== BACKGROUND_SUBAGENT_VERSION ||
        control.type !== "cancel" ||
        ![control.sessionId, control.instanceId, control.jobId].every(
            (field) => typeof field === "string" && field.length > 0 && field.length <= MAX_CONTROL_ID,
        )
    )
        return undefined;
    return control as unknown as BackgroundSubagentControlV1;
}

export interface BackgroundSubagentEventV1 {
    schema: typeof BACKGROUND_SUBAGENT_SCHEMA;
    version: typeof BACKGROUND_SUBAGENT_VERSION;
    sessionId: string;
    instanceId: string;
    type: "ready" | "upsert" | "remove" | "reset";
    job?: BackgroundSubagentJobV1;
}
