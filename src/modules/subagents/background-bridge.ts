import type { EventBusController } from "@earendil-works/pi-coding-agent";
import { boundedString, isRecord } from "#shared/lib/validate.js";
import { type Job, type JobState, SUBAGENT_JOBS_CHANNEL, type SubagentJobsEvent } from "./protocol.js";

const MAX_JOBS = 80;
const JOB_STATES = new Set<JobState>(["queued", "running", "completed", "failed", "cancelled", "timed_out"]);
const RESULT_STATES = new Set<JobState>(["completed", "failed", "timed_out"]);

/** A validated, string-bounded copy of one active Job, safe for rendering. */
export interface BackgroundSubagentViewModel extends Job {
    title: string;
}

export interface SubagentResultViewModel {
    id: string;
    profile: string;
    task: string;
    status: Extract<JobState, "completed" | "failed" | "timed_out">;
    runtimeMs: number;
    partial: boolean;
    totalTokens?: number;
    error?: string;
    location: string;
    preview: string;
}

function finiteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseJob(value: unknown): BackgroundSubagentViewModel | undefined {
    if (!isRecord(value)) return undefined;
    if (
        typeof value.id !== "string" ||
        typeof value.profile !== "string" ||
        typeof value.task !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.state !== "string" ||
        !JOB_STATES.has(value.state as JobState) ||
        !finiteNonNegative(value.createdAt) ||
        (value.startedAt !== undefined && !finiteNonNegative(value.startedAt)) ||
        (value.endedAt !== undefined && !finiteNonNegative(value.endedAt)) ||
        (value.error !== undefined && typeof value.error !== "string")
    ) {
        return undefined;
    }
    const task = boundedString(value.task, 8_000);
    const oneLine = task.replace(/\s+/g, " ").trim() || "Background subagent";
    return {
        id: boundedString(value.id, 256),
        profile: boundedString(value.profile, 128),
        task,
        title: boundedString(oneLine, 512),
        cwd: boundedString(value.cwd, 4_000),
        state: value.state as JobState,
        createdAt: value.createdAt,
        ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }),
        ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }),
        ...(value.error === undefined ? {} : { error: boundedString(value.error, 16_000) }),
    };
}

export interface ParsedSubagentJobsEvent extends Omit<SubagentJobsEvent, "jobs"> {
    jobs: BackgroundSubagentViewModel[];
}

/** Parse structured details from a persisted `subagent-result` custom message. */
export function parseSubagentResultDetails(value: unknown): SubagentResultViewModel | undefined {
    if (!isRecord(value)) return undefined;
    if (
        typeof value.id !== "string" ||
        typeof value.profile !== "string" ||
        typeof value.task !== "string" ||
        typeof value.status !== "string" ||
        !RESULT_STATES.has(value.status as JobState) ||
        !finiteNonNegative(value.runtimeMs) ||
        typeof value.partial !== "boolean" ||
        (value.totalTokens !== undefined && !finiteNonNegative(value.totalTokens)) ||
        (value.error !== undefined && typeof value.error !== "string") ||
        typeof value.location !== "string" ||
        typeof value.preview !== "string"
    ) {
        return undefined;
    }
    return {
        id: boundedString(value.id, 256),
        profile: boundedString(value.profile, 128),
        task: boundedString(value.task, 8_000),
        status: value.status as SubagentResultViewModel["status"],
        runtimeMs: value.runtimeMs,
        partial: value.partial,
        ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens as number }),
        ...(value.error === undefined ? {} : { error: boundedString(value.error, 16_000) }),
        location: boundedString(value.location, 4_000),
        preview: boundedString(value.preview, 16 * 1_024),
    };
}

/** Parse the Extension-owned active-Job snapshot and bound every rendered string. */
export function parseSubagentJobsEvent(value: unknown): ParsedSubagentJobsEvent | undefined {
    if (!isRecord(value) || typeof value.sessionId !== "string" || !Array.isArray(value.jobs)) return undefined;
    if (!value.sessionId || value.sessionId.length > 256 || value.jobs.length > MAX_JOBS) return undefined;
    const jobs: BackgroundSubagentViewModel[] = [];
    for (const candidate of value.jobs) {
        const job = parseJob(candidate);
        if (!job) return undefined;
        jobs.push(job);
    }
    return { sessionId: value.sessionId, jobs };
}

export function isTerminalSubagentStatus(state: JobState): boolean {
    return state !== "queued" && state !== "running";
}

/** Bridges the Extension's active-Job snapshots into the Controller. */
export class BackgroundSubagentBridge {
    private current: BackgroundSubagentViewModel[] = [];
    private sessionId = "";
    private unsubscribe?: () => void;

    constructor(private readonly options: { eventBus: EventBusController; onChange: () => void }) {}

    bind(sessionId: string): void {
        this.unsubscribe?.();
        this.current = [];
        this.sessionId = sessionId;
        this.unsubscribe = this.options.eventBus.on(SUBAGENT_JOBS_CHANNEL, (payload) => {
            const event = parseSubagentJobsEvent(payload);
            if (!event || event.sessionId !== this.sessionId) return;
            this.current = event.jobs;
            this.options.onChange();
        });
    }

    jobs(): BackgroundSubagentViewModel[] {
        return this.current.map((job) => ({ ...job }));
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.current = [];
    }
}
