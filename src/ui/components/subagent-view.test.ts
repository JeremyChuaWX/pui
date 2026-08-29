import { describe, expect, test } from "bun:test";
import type { BackgroundSubagentViewModel } from "#modules/subagents/interfaces/ui.js";
import { compactSubagentUsage, subagentElapsed, subagentStatusIcon, subagentStatusLabel } from "./subagent-view.js";

function job(overrides: Partial<BackgroundSubagentViewModel> = {}): BackgroundSubagentViewModel {
    return {
        id: "job-1",
        title: "Inspect controller state",
        agent: "explorer",
        model: "openai/gpt-5.4-mini",
        cwd: "/repo",
        status: "running",
        phase: "tool",
        startedAt: 1_000,
        updatedAt: 2_000,
        activeTools: [],
        recentActivity: [],
        usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60, cost: 0.0012, turns: 1 },
        ...overrides,
    };
}

describe("subagent view helpers", () => {
    test("measures elapsed time from start until now for a live Job", () => {
        expect(subagentElapsed(job(), 13_000)).toBe("12s");
    });

    test("freezes elapsed time at the end of a terminal Job", () => {
        const done = job({ status: "succeeded", phase: "exiting", endedAt: 15_000 });
        expect(subagentElapsed(done, 99_000)).toBe("14s");
        expect(subagentElapsed(job({ status: "failed", endedAt: 126_000, error: "boom" }), 999_999)).toBe("2m 5s");
    });

    test("falls back to the last update when a Job never started", () => {
        const queued = job({ status: "queued", phase: "queued", startedAt: undefined, updatedAt: 5_000 });
        expect(subagentElapsed(queued, 8_000)).toBe("3s");
    });

    test("summarises usage as turns and tokens without cost", () => {
        const usage = {
            input: 10_000,
            output: 8_000,
            cacheRead: 400,
            cacheWrite: 0,
            totalTokens: 18_400,
            cost: 0.0123,
            turns: 3,
        };
        expect(compactSubagentUsage(usage)).toBe("3 turns · 18k tokens");
        expect(compactSubagentUsage(usage)).not.toContain("$");
        expect(compactSubagentUsage({ ...usage, turns: 0, totalTokens: 0 })).toBe("");
    });

    test("formats status icons and labels", () => {
        expect(subagentStatusIcon("cancelled")).toBe("⊘");
        expect(subagentStatusIcon("timed_out")).toBe("⧖");
        expect(subagentStatusLabel("timed_out")).toBe("timed out");
        expect(subagentStatusIcon("stalled")).toBe("⧖");
        expect(subagentStatusIcon("tool_stalled")).toBe("⧖");
        expect(subagentStatusLabel("stalled")).toBe("stalled");
        expect(subagentStatusLabel("tool_stalled")).toBe("tool stalled");
        expect(subagentStatusLabel("running")).toBe("running");
    });
});
