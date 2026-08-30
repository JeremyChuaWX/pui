import { describe, expect, test } from "bun:test";
import type { BackgroundSubagentViewModel } from "#modules/subagents/interfaces/ui.js";
import {
    compactSubagentTask,
    subagentElapsed,
    subagentStatusIcon,
    subagentStatusLabel,
} from "#ui/components/subagent-view.js";

function job(overrides: Partial<BackgroundSubagentViewModel> = {}): BackgroundSubagentViewModel {
    return {
        id: "explorer_1",
        title: "Inspect controller state",
        profile: "explorer",
        task: "Inspect controller state",
        cwd: "/repo",
        state: "running",
        createdAt: 500,
        startedAt: 1_000,
        ...overrides,
    };
}

describe("subagent view helpers", () => {
    test("measures elapsed time from start until now for a live Job", () => {
        expect(subagentElapsed(job(), 13_000)).toBe("12s");
    });

    test("freezes elapsed time at the end of a terminal Job", () => {
        expect(subagentElapsed(job({ state: "completed", endedAt: 15_000 }), 99_000)).toBe("14s");
        expect(subagentElapsed(job({ state: "failed", endedAt: 126_000, error: "boom" }), 999_999)).toBe("2m 5s");
    });

    test("falls back to creation time when a Job has not started", () => {
        expect(subagentElapsed(job({ state: "queued", startedAt: undefined, createdAt: 5_000 }), 8_000)).toBe("3s");
    });

    test("compacts a multiline task for collapsed result cards", () => {
        expect(compactSubagentTask("  inspect\n   the controller  ")).toBe("inspect the controller");
        expect(compactSubagentTask("x".repeat(121))).toBe(`${"x".repeat(117)}...`);
    });

    test("formats local Extension status icons and labels", () => {
        expect(subagentStatusIcon("completed")).toBe("✓");
        expect(subagentStatusIcon("cancelled")).toBe("⊘");
        expect(subagentStatusIcon("timed_out")).toBe("⧖");
        expect(subagentStatusLabel("timed_out")).toBe("timed out");
        expect(subagentStatusLabel("running")).toBe("running");
    });
});
