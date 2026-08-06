import { describe, expect, test } from "bun:test";
import { parseBackgroundSubagentControl, parseBackgroundSubagentEvent } from "./background-protocol.js";

describe("background subagent control protocol", () => {
    const valid = {
        schema: "pi.subagent.background.control",
        version: 1,
        sessionId: "session",
        instanceId: "instance",
        type: "cancel",
        jobId: "job",
    } as const;

    test("accepts only bounded versioned cancellation messages", () => {
        expect(parseBackgroundSubagentControl(valid)).toEqual(valid);
        expect(parseBackgroundSubagentControl(null)).toBeUndefined();
        expect(parseBackgroundSubagentControl([valid])).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, schema: "pi.subagent.background" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, version: 2 })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, type: "steer" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, jobId: "" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, jobId: "x".repeat(257) })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, sessionId: "" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, instanceId: null })).toBeUndefined();
    });
});

describe("background subagent event protocol", () => {
    const upsert = (job: Record<string, unknown>) => ({
        schema: "pi.subagent.background",
        version: 1,
        sessionId: "session",
        instanceId: "instance",
        type: "upsert",
        job: {
            id: "job",
            title: "Inspect target",
            prompt: "Inspect everything",
            run: {
                id: "job",
                agent: "explore",
                model: "default",
                cwd: "/tmp",
                status: "running",
                updatedAt: 1,
                activeTools: [],
                recentActivity: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
            },
            ...job,
        },
    });

    test("bounds job title and prompt lengths", () => {
        expect(parseBackgroundSubagentEvent(upsert({}))).toBeDefined();
        expect(parseBackgroundSubagentEvent(upsert({ prompt: undefined }))).toBeDefined();
        expect(parseBackgroundSubagentEvent(upsert({ title: "x".repeat(4_097) }))).toBeUndefined();
        expect(parseBackgroundSubagentEvent(upsert({ prompt: "x".repeat(64 * 1024 + 1) }))).toBeUndefined();
    });
});
