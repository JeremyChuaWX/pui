import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
    BackgroundSubagentBridge,
    parseSubagentJobsEvent,
    parseSubagentResultDetails,
} from "#modules/subagents/background-bridge.js";
import { SUBAGENT_JOBS_CHANNEL } from "#modules/subagents/protocol.js";

function event(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: "session-a",
        jobs: [
            {
                id: "explorer_1",
                profile: "explorer",
                task: "Inspect the target",
                cwd: "/repo",
                state: "running",
                createdAt: 1,
                startedAt: 2,
            },
        ],
        ...overrides,
    };
}

describe("background subagent UI bridge", () => {
    test("parses active-Job snapshots and rejects malformed payloads", () => {
        expect(parseSubagentJobsEvent(event())).toEqual({
            ...event(),
            jobs: [expect.objectContaining({ title: "Inspect the target" })],
        });
        expect(parseSubagentJobsEvent(null)).toBeUndefined();
        expect(parseSubagentJobsEvent(event({ sessionId: "" }))).toBeUndefined();
        expect(parseSubagentJobsEvent(event({ jobs: [{ id: "bad" }] }))).toBeUndefined();
        expect(
            parseSubagentJobsEvent(event({ jobs: Array.from({ length: 81 }, () => event().jobs[0]) })),
        ).toBeUndefined();
    });

    test("bounds strings, replaces complete snapshots, and ignores another session", () => {
        const eventBus = createEventBus();
        let changes = 0;
        const bridge = new BackgroundSubagentBridge({ eventBus, onChange: () => changes++ });
        bridge.bind("session-a");
        const payload = event();
        (payload.jobs[0] as { task: string }).task = `  ${"x".repeat(9_000)}  `;
        eventBus.emit(SUBAGENT_JOBS_CHANNEL, payload);
        expect(changes).toBe(1);
        expect(bridge.jobs()[0]).toMatchObject({
            id: "explorer_1",
            state: "running",
        });
        expect(bridge.jobs()[0]!.title.length).toBe(512);
        expect(bridge.jobs()[0]!.title.endsWith("…")).toBe(true);
        expect(bridge.jobs()[0]!.task.length).toBe(8_000);

        eventBus.emit(SUBAGENT_JOBS_CHANNEL, event({ sessionId: "other", jobs: [] }));
        expect(bridge.jobs()).toHaveLength(1);
        eventBus.emit(SUBAGENT_JOBS_CHANNEL, event({ jobs: [] }));
        expect(bridge.jobs()).toEqual([]);
        bridge.dispose();
    });

    test("parses and bounds structured result details", () => {
        const details = parseSubagentResultDetails({
            id: "explorer_1",
            profile: "explorer",
            task: "x".repeat(9_000),
            status: "completed",
            runtimeMs: 2_000,
            partial: false,
            totalTokens: 12,
            location: "/tmp/result.md",
            preview: "done",
        });
        expect(details).toMatchObject({ id: "explorer_1", status: "completed", preview: "done" });
        expect(details?.task.length).toBe(8_000);
        expect(parseSubagentResultDetails({ status: "running" })).toBeUndefined();
    });
});
