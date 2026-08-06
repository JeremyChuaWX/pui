import type { EventBusController } from "@earendil-works/pi-coding-agent";
import { boundedString } from "../extensions/shared/validate.js";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
    type BackgroundSubagentEventV1,
    parseBackgroundSubagentEvent as parseWireEvent,
} from "../extensions/subagent/background-protocol.js";
import type { InstanceScopedRuns } from "./instance-scoped-runs.js";
import { reduceInstanceScopedRuns } from "./instance-scoped-runs.js";
import type { SubagentViewModel } from "./subagent.js";
import { isTerminalSubagentStatus, normalizeSubagentDetails } from "./subagent.js";

export { BACKGROUND_SUBAGENT_CHANNEL, BACKGROUND_SUBAGENT_CONTROL_CHANNEL, BACKGROUND_SUBAGENT_CONTROL_SCHEMA };

const MAX_TITLE = 512;
const MAX_PROMPT = 8_000;
const MAX_JOBS = 64;

export interface BackgroundSubagentViewModel extends SubagentViewModel {
    title: string;
}

type BackgroundSubagentEvent =
    | { type: "ready" | "reset"; sessionId: string; instanceId: string }
    | { type: "upsert" | "remove"; sessionId: string; instanceId: string; job: BackgroundSubagentViewModel };

/** Parse the extension-owned wire format, then bound all host view-model strings. */
export function parseBackgroundSubagentEvent(value: unknown): BackgroundSubagentEvent | undefined {
    const event = parseWireEvent(value);
    if (!event) return undefined;
    if (event.type === "ready" || event.type === "reset")
        return { type: event.type, sessionId: event.sessionId, instanceId: event.instanceId };
    const job = event.job as NonNullable<BackgroundSubagentEventV1["job"]>;
    const run = normalizeSubagentDetails(
        { schema: "pi.subagent", version: 1, run: job.run },
        { args: job.prompt === undefined ? undefined : { prompt: job.prompt } },
    );
    if (!run) return undefined;
    return {
        type: event.type,
        sessionId: event.sessionId,
        instanceId: event.instanceId,
        job: {
            ...run,
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
