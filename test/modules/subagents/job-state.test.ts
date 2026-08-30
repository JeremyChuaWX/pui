import { describe, expect, test } from "bun:test";
import {
    appendSubagentActivity,
    createInitialSubagentJob,
    createTerminalSubagentJob,
    isSubagentJobV1,
    MAX_RECENT_ACTIVITY,
    MAX_SUBAGENT_ACTIVE_TOOLS,
    updateSubagentJob,
} from "#modules/subagents/job-state.ts";

describe("subagent Job state", () => {
    test("creates a valid queued Job", () => {
        const job = createInitialSubagentJob({
            id: "job-7",
            agent: "explorer",
            model: "provider/model:off",
            cwd: "/repo",
            now: 100,
        });

        expect(job.id).toBe("job-7");
        expect(job.status).toBe("queued");
        expect(job.phase).toBe("queued");
        expect(isSubagentJobV1(job)).toBe(true);
    });

    test("terminal transitions always clear active tools", () => {
        const initial = createInitialSubagentJob({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 1 });
        const running = updateSubagentJob(
            initial,
            {
                status: "running",
                phase: "tool",
                activeTools: [{ id: "child-tool", name: "read", title: "read src/a.ts", startedAt: 2 }],
            },
            2,
        );
        const done = createTerminalSubagentJob(running, { status: "failed", error: "boom" }, 3);

        expect(done.activeTools).toEqual([]);
        expect(done.phase).toBe("exiting");
        expect(done.endedAt).toBe(3);
        expect(isSubagentJobV1(done)).toBe(true);

        const patchedTerminal = updateSubagentJob(
            running,
            { status: "timed_out", activeTools: running.activeTools },
            4,
        );
        expect(patchedTerminal.activeTools).toEqual([]);
    });

    test("keeps only the newest active tools and rejects oversized payloads", () => {
        const initial = createInitialSubagentJob({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 1 });
        const activeTools = Array.from({ length: MAX_SUBAGENT_ACTIVE_TOOLS + 1 }, (_, index) => ({
            id: `tool-${index}`,
            name: "read",
            title: `read ${index}`,
            startedAt: index + 2,
        }));
        const running = updateSubagentJob(initial, { status: "running", activeTools }, 2);

        expect(running.activeTools).toHaveLength(MAX_SUBAGENT_ACTIVE_TOOLS);
        expect(running.activeTools[0]?.id).toBe("tool-1");
        expect(running.activeTools.at(-1)?.id).toBe(`tool-${MAX_SUBAGENT_ACTIVE_TOOLS}`);
        expect(isSubagentJobV1(running)).toBe(true);
        expect(isSubagentJobV1({ ...running, activeTools })).toBe(false);
    });

    test("orders and caps recent activity", () => {
        let job = createInitialSubagentJob({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 0 });
        for (let index = 0; index < MAX_RECENT_ACTIVITY + 7; index++) {
            job = appendSubagentActivity(job, { timestamp: index + 1, kind: "diagnostic", title: `item ${index}` });
        }

        expect(job.recentActivity).toHaveLength(MAX_RECENT_ACTIVITY);
        expect(job.recentActivity[0]?.title).toBe("item 7");
        expect(job.recentActivity.map((item) => item.sequence)).toEqual(
            Array.from({ length: MAX_RECENT_ACTIVITY }, (_, index) => index + 8),
        );
        expect(isSubagentJobV1(job)).toBe(true);
    });

    test("rejects malformed payloads", () => {
        const job = createInitialSubagentJob({ id: "id", agent: "explorer", model: "m", cwd: "/repo", now: 1 });
        expect(isSubagentJobV1(null)).toBe(false);
        expect(isSubagentJobV1({ ...job, activeTools: "bad" })).toBe(false);
        expect(isSubagentJobV1({ ...job, status: "exploding" })).toBe(false);
    });
});
