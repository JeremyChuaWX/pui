import type { EventBusController } from "@earendil-works/pi-coding-agent";
import { boundedString } from "#shared/lib/validate.js";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
    type BackgroundSubagentEventV1,
    parseBackgroundSubagentEvent as parseWireEvent,
} from "./background-protocol.js";
import type { InstanceScopedJobs } from "./instance-scoped-jobs.js";
import { reduceInstanceScopedJobs } from "./instance-scoped-jobs.js";
import {
    isTerminalSubagentStatus,
    type SubagentActiveToolV1,
    type SubagentActivityV1,
    type SubagentJobV1,
} from "./job-state.js";

const MAX_TITLE = 512;
const MAX_PROMPT = 8_000;
const MAX_JOBS = 64;

/** A validated, string-bounded copy of one Job, safe for rendering. */
export interface BackgroundSubagentViewModel extends SubagentJobV1 {
    title: string;
    prompt?: string;
}

type BackgroundSubagentEvent =
    | { type: "ready" | "reset"; sessionId: string; instanceId: string }
    | { type: "upsert" | "remove"; sessionId: string; instanceId: string; job: BackgroundSubagentViewModel };

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

function boundedJob(job: SubagentJobV1): SubagentJobV1 {
    return {
        id: boundedString(job.id, 256),
        agent: boundedString(job.agent, 128),
        model: boundedString(job.model, 256),
        cwd: boundedString(job.cwd, 4_000),
        status: job.status,
        ...(job.phase === undefined ? {} : { phase: job.phase }),
        ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
        updatedAt: job.updatedAt,
        ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
        activeTools: job.activeTools.map(boundedTool),
        recentActivity: job.recentActivity.map(boundedActivity),
        usage: { ...job.usage },
        ...(job.outputPreview === undefined ? {} : { outputPreview: boundedString(job.outputPreview, 16_000) }),
        ...(job.error === undefined ? {} : { error: boundedString(job.error, 16_000) }),
        ...(job.fullOutputPath === undefined ? {} : { fullOutputPath: boundedString(job.fullOutputPath, 4_000) }),
    };
}

/** Parse the extension-owned wire format, then bound every string the views will render. */
export function parseBackgroundSubagentEvent(value: unknown): BackgroundSubagentEvent | undefined {
    const event = parseWireEvent(value);
    if (!event) return undefined;
    if (event.type === "ready" || event.type === "reset")
        return { type: event.type, sessionId: event.sessionId, instanceId: event.instanceId };
    const job = event.job as NonNullable<BackgroundSubagentEventV1["job"]>;
    return {
        type: event.type,
        sessionId: event.sessionId,
        instanceId: event.instanceId,
        job: {
            ...boundedJob(job.state),
            title: boundedString(job.title, MAX_TITLE),
            ...(job.prompt === undefined ? {} : { prompt: boundedString(job.prompt, MAX_PROMPT) }),
        },
    };
}

export type BackgroundSubagentState = InstanceScopedJobs<BackgroundSubagentViewModel>;

export class BackgroundSubagentBridge {
    private state: BackgroundSubagentState = { jobs: new Map() };
    private sessionId = "";
    private unsubscribe?: () => void;

    constructor(private readonly options: { eventBus: EventBusController; onChange: () => void }) {}

    bind(sessionId: string): void {
        this.unsubscribe?.();
        this.state = { jobs: new Map() };
        this.sessionId = sessionId;
        this.unsubscribe = this.options.eventBus.on(BACKGROUND_SUBAGENT_CHANNEL, (payload) => {
            const event = parseBackgroundSubagentEvent(payload);
            if (!event) return;
            const next = reduceBackgroundSubagentEvent(this.state, event, this.sessionId);
            if (next === this.state) return;
            this.state = next;
            this.options.onChange();
        });
    }

    jobs(): BackgroundSubagentViewModel[] {
        return [...this.state.jobs.values()];
    }

    cancel(id: string): boolean {
        const job = this.state.jobs.get(id);
        if (!job || !this.state.instanceId || isTerminalSubagentStatus(job.status)) return false;
        this.options.eventBus.emit(BACKGROUND_SUBAGENT_CONTROL_CHANNEL, {
            schema: BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
            version: 1,
            sessionId: this.sessionId,
            instanceId: this.state.instanceId,
            type: "cancel",
            jobId: id,
        });
        return true;
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.state = { jobs: new Map() };
    }
}

export function reduceBackgroundSubagentEvent(
    state: BackgroundSubagentState,
    event: BackgroundSubagentEvent,
    sessionId: string,
): BackgroundSubagentState {
    return reduceInstanceScopedJobs(
        state,
        event.type === "upsert" || event.type === "remove"
            ? { type: event.type, instanceId: event.instanceId, job: event.job }
            : { type: event.type, instanceId: event.instanceId },
        { routeMatches: event.sessionId === sessionId, maxJobs: MAX_JOBS, id: (job) => job.id },
    );
}
