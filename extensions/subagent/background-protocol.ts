import { isRecord } from "../shared/validate.js";
import { isSubagentDetailsV1, type SubagentRunV1 } from "./protocol.js";

export const BACKGROUND_SUBAGENT_CHANNEL = "pui.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_CHANNEL = "pui.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_SCHEMA = "pi.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_SCHEMA = "pi.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_VERSION = 1 as const;
const MAX_CONTROL_ID = 256;
const MAX_JOB_TITLE = 4_096;
const MAX_JOB_PROMPT = 64 * 1024;

export interface BackgroundSubagentJobV1 {
    id: string;
    title: string;
    prompt?: string;
    run: SubagentRunV1;
}

export interface BackgroundSubagentEventV1 {
    schema: typeof BACKGROUND_SUBAGENT_SCHEMA;
    version: typeof BACKGROUND_SUBAGENT_VERSION;
    sessionId: string;
    instanceId: string;
    type: "ready" | "reset" | "upsert" | "remove";
    job?: BackgroundSubagentJobV1;
}

export interface BackgroundSubagentControlV1 {
    schema: typeof BACKGROUND_SUBAGENT_CONTROL_SCHEMA;
    version: typeof BACKGROUND_SUBAGENT_VERSION;
    sessionId: string;
    instanceId: string;
    type: "cancel";
    jobId: string;
}

export function parseBackgroundSubagentEvent(value: unknown): BackgroundSubagentEventV1 | undefined {
    if (
        !isRecord(value) ||
        value.schema !== BACKGROUND_SUBAGENT_SCHEMA ||
        value.version !== BACKGROUND_SUBAGENT_VERSION
    )
        return undefined;
    if (
        ![value.sessionId, value.instanceId].every(
            (field) => typeof field === "string" && field.length > 0 && field.length <= MAX_CONTROL_ID,
        )
    )
        return undefined;
    if (value.type === "ready" || value.type === "reset")
        return value.job === undefined ? (value as unknown as BackgroundSubagentEventV1) : undefined;
    if ((value.type !== "upsert" && value.type !== "remove") || !isRecord(value.job)) return undefined;
    const job = value.job;
    if (
        typeof job.id !== "string" ||
        job.id.length === 0 ||
        job.id.length > MAX_CONTROL_ID ||
        typeof job.title !== "string" ||
        job.title.length === 0 ||
        job.title.length > MAX_JOB_TITLE ||
        (job.prompt !== undefined && (typeof job.prompt !== "string" || job.prompt.length > MAX_JOB_PROMPT)) ||
        !isSubagentDetailsV1({ schema: "pi.subagent", version: 1, run: job.run }) ||
        (job.run as SubagentRunV1).id !== job.id
    )
        return undefined;
    return value as unknown as BackgroundSubagentEventV1;
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
