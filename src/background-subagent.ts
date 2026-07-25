import type { SubagentViewModel } from "./subagent.js";
import { normalizeSubagentDetails } from "./subagent.js";

export const BACKGROUND_SUBAGENT_CHANNEL = "pui.subagent.background" as const;
export const BACKGROUND_SUBAGENT_CONTROL_CHANNEL = "pui.subagent.background.control" as const;
export const BACKGROUND_SUBAGENT_CONTROL_SCHEMA = "pi.subagent.background.control" as const;
const SCHEMA = "pi.subagent.background";
const MAX_ID = 256;
const MAX_TITLE = 512;
const MAX_PROMPT = 8_000;
const MAX_JOBS = 64;

export interface BackgroundSubagentViewModel extends SubagentViewModel {
    title: string;
}

export type BackgroundSubagentEvent =
    | { type: "ready" | "reset"; sessionId: string; instanceId: string }
    | { type: "upsert" | "remove"; sessionId: string; instanceId: string; job: BackgroundSubagentViewModel };

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identity(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

function bounded(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Parse the extension wire format without trusting or importing extension runtime code. */
export function parseBackgroundSubagentEvent(value: unknown): BackgroundSubagentEvent | undefined {
    if (!record(value) || value.schema !== SCHEMA || value.version !== 1) return undefined;
    if (!identity(value.sessionId) || !identity(value.instanceId)) return undefined;
    if (value.type === "ready" || value.type === "reset") {
        if (value.job !== undefined) return undefined;
        return { type: value.type, sessionId: value.sessionId, instanceId: value.instanceId };
    }
    if ((value.type !== "upsert" && value.type !== "remove") || !record(value.job)) return undefined;
    const job = value.job;
    if (!identity(job.id) || typeof job.title !== "string" || job.title.length === 0 || !record(job.run))
        return undefined;
    if (job.prompt !== undefined && typeof job.prompt !== "string") return undefined;
    const run = normalizeSubagentDetails(
        { schema: "pi.subagent", version: 1, run: job.run },
        { args: job.prompt === undefined ? undefined : { prompt: job.prompt } },
    );
    if (!run || run.id !== job.id) return undefined;
    return {
        type: value.type,
        sessionId: value.sessionId,
        instanceId: value.instanceId,
        job: {
            ...run,
            title: bounded(job.title, MAX_TITLE),
            ...(job.prompt === undefined ? {} : { prompt: bounded(job.prompt, MAX_PROMPT) }),
        },
    };
}

export interface BackgroundSubagentState {
    instanceId?: string;
    jobs: ReadonlyMap<string, BackgroundSubagentViewModel>;
}

export function reduceBackgroundSubagentEvent(
    state: BackgroundSubagentState,
    event: BackgroundSubagentEvent,
    sessionId: string,
): BackgroundSubagentState {
    if (event.sessionId !== sessionId) return state;
    if (event.type === "ready") {
        if (state.instanceId !== undefined && state.instanceId !== event.instanceId) return state;
        return state.instanceId === event.instanceId ? state : { instanceId: event.instanceId, jobs: new Map() };
    }
    if (event.instanceId !== state.instanceId) return state;
    if (event.type === "reset") return { jobs: new Map() };
    const jobs = new Map(state.jobs);
    if (event.type === "upsert") {
        if (!jobs.has(event.job.id) && jobs.size >= MAX_JOBS) return state;
        jobs.set(event.job.id, event.job);
    } else if (event.type === "remove") jobs.delete(event.job.id);
    return { instanceId: state.instanceId, jobs };
}
