import { describe, expect, test } from "bun:test";
import {
    appendSubagentActivity,
    createInitialSubagentRun,
    createTerminalSubagentRun,
    isSubagentRunV1,
    MAX_RECENT_ACTIVITY,
    MAX_SUBAGENT_ACTIVE_TOOLS,
    updateSubagentRun,
} from "./run-state.ts";

describe("subagent run state", () => {
    test("creates a valid queued run", () => {
        const run = createInitialSubagentRun({
            id: "job-7",
            agent: "explorer",
            model: "provider/model:off",
            cwd: "/repo",
            now: 100,
        });

        expect(run.id).toBe("job-7");
        expect(run.status).toBe("queued");
        expect(run.phase).toBe("queued");
        expect(isSubagentRunV1(run)).toBe(true);
    });

    test("terminal transitions always clear active tools", () => {
        const initial = createInitialSubagentRun({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 1 });
        const running = updateSubagentRun(
            initial,
            {
                status: "running",
                phase: "tool",
                activeTools: [{ id: "child-tool", name: "read", title: "read src/a.ts", startedAt: 2 }],
            },
            2,
        );
        const done = createTerminalSubagentRun(running, { status: "failed", error: "boom" }, 3);

        expect(done.activeTools).toEqual([]);
        expect(done.phase).toBe("exiting");
        expect(done.endedAt).toBe(3);
        expect(isSubagentRunV1(done)).toBe(true);

        const patchedTerminal = updateSubagentRun(
            running,
            { status: "timed_out", activeTools: running.activeTools },
            4,
        );
        expect(patchedTerminal.activeTools).toEqual([]);
    });

    test("keeps only the newest active tools and rejects oversized payloads", () => {
        const initial = createInitialSubagentRun({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 1 });
        const activeTools = Array.from({ length: MAX_SUBAGENT_ACTIVE_TOOLS + 1 }, (_, index) => ({
            id: `tool-${index}`,
            name: "read",
            title: `read ${index}`,
            startedAt: index + 2,
        }));
        const running = updateSubagentRun(initial, { status: "running", activeTools }, 2);

        expect(running.activeTools).toHaveLength(MAX_SUBAGENT_ACTIVE_TOOLS);
        expect(running.activeTools[0]?.id).toBe("tool-1");
        expect(running.activeTools.at(-1)?.id).toBe(`tool-${MAX_SUBAGENT_ACTIVE_TOOLS}`);
        expect(isSubagentRunV1(running)).toBe(true);
        expect(isSubagentRunV1({ ...running, activeTools })).toBe(false);
    });

    test("orders and caps recent activity", () => {
        let run = createInitialSubagentRun({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 0 });
        for (let index = 0; index < MAX_RECENT_ACTIVITY + 7; index++) {
            run = appendSubagentActivity(run, { timestamp: index + 1, kind: "diagnostic", title: `item ${index}` });
        }

        expect(run.recentActivity).toHaveLength(MAX_RECENT_ACTIVITY);
        expect(run.recentActivity[0]?.title).toBe("item 7");
        expect(run.recentActivity.map((item) => item.sequence)).toEqual(
            Array.from({ length: MAX_RECENT_ACTIVITY }, (_, index) => index + 8),
        );
        expect(isSubagentRunV1(run)).toBe(true);
    });

    test("rejects malformed payloads", () => {
        const run = createInitialSubagentRun({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 1 });
        expect(isSubagentRunV1(null)).toBe(false);
        expect(isSubagentRunV1({ ...run, activeTools: "bad" })).toBe(false);
        expect(isSubagentRunV1({ ...run, status: "exploding" })).toBe(false);
    });
});
