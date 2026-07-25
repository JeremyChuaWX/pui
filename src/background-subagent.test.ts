import { describe, expect, test } from "bun:test";
import {
    type BackgroundSubagentState,
    parseBackgroundSubagentEvent,
    reduceBackgroundSubagentEvent,
} from "./background-subagent.js";

function event(type: "ready" | "upsert" | "remove" | "reset", overrides: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = {
        schema: "pi.subagent.background",
        version: 1,
        sessionId: "session-a",
        instanceId: "instance-a",
        type,
    };
    if (type === "upsert" || type === "remove") {
        base.job = {
            id: "job-a",
            title: "Inspect target",
            prompt: "Inspect everything",
            run: {
                id: "job-a",
                agent: "explore",
                model: "provider/model:off",
                cwd: "/tmp",
                status: "running",
                phase: "tool",
                startedAt: 1,
                updatedAt: 2,
                activeTools: [{ id: "tool", name: "read", title: "read file", startedAt: 2 }],
                recentActivity: [{ sequence: 1, timestamp: 2, kind: "tool_start", title: "read file" }],
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 },
                outputPreview: "partial",
            },
        };
    }
    return { ...base, ...overrides };
}

function parse(value: unknown) {
    const parsed = parseBackgroundSubagentEvent(value);
    if (!parsed) throw new Error("Expected valid event");
    return parsed;
}

describe("background subagent host protocol", () => {
    test("parses and bounds complete v1 snapshots", () => {
        const payload = event("upsert");
        (payload.job as Record<string, unknown>).title = "x".repeat(1_000);
        const parsed = parse(payload);
        expect(parsed.type).toBe("upsert");
        if (parsed.type !== "upsert") throw new Error("Expected upsert");
        expect(parsed.job.title.length).toBe(512);
        expect(parsed.job.model).toBe("provider/model:off");
        expect(parsed.job.activeTools[0]?.name).toBe("read");
    });

    test("keeps background envelopes parseable at the producer active-tool maximum", () => {
        const payload = event("upsert");
        const run = (payload.job as any).run as any;
        run.activeTools = Array.from({ length: 64 }, (_, index) => ({
            id: `tool-${index}`,
            name: "read",
            title: `read ${index}`,
            startedAt: index + 1,
        }));
        expect(parseBackgroundSubagentEvent(payload)).toBeDefined();

        run.activeTools.push({ id: "tool-64", name: "read", title: "read 64", startedAt: 65 });
        expect(parseBackgroundSubagentEvent(payload)).toBeUndefined();
    });

    test("rejects malformed fields, mismatched ids, and unknown versions/types", () => {
        expect(parseBackgroundSubagentEvent(null)).toBeUndefined();
        expect(parseBackgroundSubagentEvent(event("ready", { version: 2 }))).toBeUndefined();
        expect(parseBackgroundSubagentEvent(event("ready", { type: "future" }))).toBeUndefined();
        expect(parseBackgroundSubagentEvent(event("ready", { sessionId: "" }))).toBeUndefined();
        expect(parseBackgroundSubagentEvent(event("ready", { job: {} }))).toBeUndefined();
        const mismatch = event("upsert");
        ((mismatch.job as any).run as any).id = "other";
        expect(parseBackgroundSubagentEvent(mismatch)).toBeUndefined();
        const malformed = event("upsert");
        ((malformed.job as any).run as any).usage.totalTokens = -1;
        expect(parseBackgroundSubagentEvent(malformed)).toBeUndefined();
    });

    test("reduces ready, upsert, remove, and reset", () => {
        let state: BackgroundSubagentState = { jobs: new Map() };
        state = reduceBackgroundSubagentEvent(state, parse(event("ready")), "session-a");
        state = reduceBackgroundSubagentEvent(state, parse(event("upsert")), "session-a");
        expect(state.jobs.get("job-a")?.title).toBe("Inspect target");
        state = reduceBackgroundSubagentEvent(state, parse(event("remove")), "session-a");
        expect(state.jobs.size).toBe(0);
        state = reduceBackgroundSubagentEvent(state, parse(event("upsert")), "session-a");
        state = reduceBackgroundSubagentEvent(state, parse(event("reset")), "session-a");
        expect(state).toEqual({ jobs: new Map() });
    });

    test("ignores stale sessions and instances", () => {
        const state = reduceBackgroundSubagentEvent({ jobs: new Map() }, parse(event("ready")), "session-a");
        const current = reduceBackgroundSubagentEvent(state, parse(event("upsert")), "session-a");
        expect(reduceBackgroundSubagentEvent(current, parse(event("upsert", { sessionId: "old" })), "session-a")).toBe(
            current,
        );
        expect(reduceBackgroundSubagentEvent(current, parse(event("upsert", { instanceId: "old" })), "session-a")).toBe(
            current,
        );
        expect(reduceBackgroundSubagentEvent(current, parse(event("remove", { instanceId: "old" })), "session-a")).toBe(
            current,
        );
        expect(reduceBackgroundSubagentEvent(current, parse(event("reset", { instanceId: "old" })), "session-a")).toBe(
            current,
        );
        expect(reduceBackgroundSubagentEvent(current, parse(event("ready", { instanceId: "old" })), "session-a")).toBe(
            current,
        );
    });

    test("bounds the host to 64 complete job snapshots", () => {
        let state: BackgroundSubagentState = { jobs: new Map() };
        state = reduceBackgroundSubagentEvent(state, parse(event("ready")), "session-a");
        for (let index = 0; index < 65; index++) {
            const payload = event("upsert");
            const job = payload.job as any;
            job.id = `job-${index}`;
            job.run.id = job.id;
            state = reduceBackgroundSubagentEvent(state, parse(payload), "session-a");
        }
        expect(state.jobs.size).toBe(64);
    });
});
