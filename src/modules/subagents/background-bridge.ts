import type { EventBusController } from "@earendil-works/pi-coding-agent";
import { boundedString } from "#shared/lib/validate.js";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
    type BackgroundSubagentEventV1,
    parseBackgroundSubagentEvent as parseWireEvent,
} from "./background-protocol.js";
import type { InstanceScopedRuns } from "./instance-scoped-runs.js";
import { reduceInstanceScopedRuns } from "./instance-scoped-runs.js";
import {
    isTerminalSubagentStatus,
    type SubagentActiveToolV1,
    type SubagentActivityV1,
    type SubagentRunV1,
} from "./run-state.js";

const MAX_TITLE = 512;
const MAX_PROMPT = 8_000;
const MAX_JOBS = 64;

/** A validated, string-bounded copy of one Job, safe for rendering. */
export interface BackgroundSubagentViewModel extends SubagentRunV1 {
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

function boundedRun(run: SubagentRunV1): SubagentRunV1 {
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
            ...boundedRun(job.run),
            title: boundedString(job.title, MAX_TITLE),
            ...(job.prompt === undefined ? {} : { prompt: boundedString(job.prompt, MAX_PROMPT) }),
        },
    };
}

export type BackgroundSubagentState = InstanceScopedRuns<BackgroundSubagentViewModel>;

export class BackgroundSubagentBridge {
    private state: BackgroundSubagentState = { runs: new Map() };
    private sessionId = "";
    private unsubscribe?: () => void;

    constructor(private readonly options: { eventBus: EventBusController; onChange: () => void }) {}

    bind(sessionId: string): void {
        this.unsubscribe?.();
        this.state = { runs: new Map() };
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
        return [...this.state.runs.values()];
    }

    cancel(id: string): boolean {
        const job = this.state.runs.get(id);
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
        this.state = { runs: new Map() };
    }
}

export function reduceBackgroundSubagentEvent(
    state: BackgroundSubagentState,
    event: BackgroundSubagentEvent,
    sessionId: string,
): BackgroundSubagentState {
    return reduceInstanceScopedRuns(
        state,
        event.type === "upsert" || event.type === "remove"
            ? { type: event.type, instanceId: event.instanceId, run: event.job }
            : { type: event.type, instanceId: event.instanceId },
        { routeMatches: event.sessionId === sessionId, maxRuns: MAX_JOBS, id: (job) => job.id },
    );
}
