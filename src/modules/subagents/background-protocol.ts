import { isRecord } from "#shared/lib/validate.js";
import { isSubagentJobV1, type SubagentJobV1 } from "./job-state.js";

export const BACKGROUND_SUBAGENT_CHANNEL = "pui.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_CHANNEL = "pui.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_SCHEMA = "pi.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_SCHEMA = "pi.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_VERSION = 1 as const;
/** Producer and consumer track at most this many Jobs; the producer prunes the oldest terminal Job first. */
export const MAX_TRACKED_JOBS = 64;
/**
 * Version 1 of the envelope serialises the Job state under the key `run`. The key is frozen with
 * the schema version; in process the same value is `state`. Only `encodeBackgroundSubagentJob`
 * and `parseBackgroundSubagentEvent` touch the wire key.
 */
const WIRE_JOB_STATE_KEY = "run" as const;
const MAX_CONTROL_ID = 256;
const MAX_JOB_TITLE = 4_096;
const MAX_JOB_PROMPT = 64 * 1024;

/** One Job as the Background Protocol carries it: identity, title, prompt, and the Job state. */
export interface BackgroundSubagentJobV1 {
    id: string;
    title: string;
    prompt?: string;
    state: SubagentJobV1;
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

/** The version 1 wire shape of one Job. Producers put this under `job` in the envelope. */
export function encodeBackgroundSubagentJob(job: BackgroundSubagentJobV1): Record<string, unknown> {
    return {
        id: job.id,
        title: job.title,
        ...(job.prompt === undefined ? {} : { prompt: job.prompt }),
        [WIRE_JOB_STATE_KEY]: job.state,
    };
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
    const state = job[WIRE_JOB_STATE_KEY];
    if (
        typeof job.id !== "string" ||
        job.id.length === 0 ||
        job.id.length > MAX_CONTROL_ID ||
        typeof job.title !== "string" ||
        job.title.length === 0 ||
        job.title.length > MAX_JOB_TITLE ||
        (job.prompt !== undefined &&
            (typeof job.prompt !== "string" || Buffer.byteLength(job.prompt, "utf8") > MAX_JOB_PROMPT)) ||
        !isSubagentJobV1(state) ||
        state.id !== job.id
    )
        return undefined;
    return {
        schema: BACKGROUND_SUBAGENT_SCHEMA,
        version: BACKGROUND_SUBAGENT_VERSION,
        sessionId: value.sessionId as string,
        instanceId: value.instanceId as string,
        type: value.type,
        job: {
            id: job.id,
            title: job.title,
            ...(job.prompt === undefined ? {} : { prompt: job.prompt }),
            state,
        },
    };
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
