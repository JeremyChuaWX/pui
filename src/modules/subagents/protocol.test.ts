import { describe, expect, test } from "bun:test";
import {
    appendSubagentActivity,
    createInitialSubagentDetails,
    createTerminalSubagentDetails,
    isSubagentDetailsV1,
    MAX_RECENT_ACTIVITY,
    MAX_SUBAGENT_ACTIVE_TOOLS,
    updateSubagentDetails,
} from "./protocol.ts";

describe("subagent protocol", () => {
    test("creates a valid queued snapshot using the outer tool call id", () => {
        const details = createInitialSubagentDetails({
            id: "outer-call-7",
            agent: "explore",
            model: "provider/model:off",
            cwd: "/repo",
            now: 100,
        });

        expect(details.run.id).toBe("outer-call-7");
        expect(details.run.status).toBe("queued");
        expect(details.run.phase).toBe("queued");
        expect(isSubagentDetailsV1(details)).toBe(true);
    });

    test("terminal transitions always clear active tools", () => {
        const initial = createInitialSubagentDetails({ id: "id", agent: "explore", model: "m", cwd: "/repo", now: 1 });
        const running = updateSubagentDetails(
            initial,
            {
                status: "running",
                phase: "tool",
                activeTools: [{ id: "child-tool", name: "read", title: "read src/a.ts", startedAt: 2 }],
            },
            2,
        );
        const done = createTerminalSubagentDetails(running, { status: "failed", error: "boom" }, 3);

        expect(done.run.activeTools).toEqual([]);
        expect(done.run.phase).toBe("exiting");
        expect(done.run.endedAt).toBe(3);
        expect(isSubagentDetailsV1(done)).toBe(true);

        const patchedTerminal = updateSubagentDetails(
            running,
            { status: "timed_out", activeTools: running.run.activeTools },
            4,
        );
        expect(patchedTerminal.run.activeTools).toEqual([]);
    });

    test("publishes only the newest active tools and rejects oversized wire snapshots", () => {
        const initial = createInitialSubagentDetails({ id: "id", agent: "explore", model: "m", cwd: "/repo", now: 1 });
        const activeTools = Array.from({ length: MAX_SUBAGENT_ACTIVE_TOOLS + 1 }, (_, index) => ({
            id: `tool-${index}`,
            name: "read",
            title: `read ${index}`,
            startedAt: index + 2,
        }));
        const running = updateSubagentDetails(initial, { status: "running", activeTools }, 2);

        expect(running.run.activeTools).toHaveLength(MAX_SUBAGENT_ACTIVE_TOOLS);
        expect(running.run.activeTools[0]?.id).toBe("tool-1");
        expect(running.run.activeTools.at(-1)?.id).toBe(`tool-${MAX_SUBAGENT_ACTIVE_TOOLS}`);
        expect(isSubagentDetailsV1(running)).toBe(true);
        expect(isSubagentDetailsV1({ ...running, run: { ...running.run, activeTools } })).toBe(false);
    });

    test("orders and caps recent activity", () => {
        let details = createInitialSubagentDetails({ id: "id", agent: "explore", model: "m", cwd: "/repo", now: 0 });
        for (let index = 0; index < MAX_RECENT_ACTIVITY + 7; index++) {
            details = appendSubagentActivity(details, {
                timestamp: index + 1,
                kind: "diagnostic",
                title: `item ${index}`,
            });
        }

        expect(details.run.recentActivity).toHaveLength(MAX_RECENT_ACTIVITY);
        expect(details.run.recentActivity[0]?.title).toBe("item 7");
        expect(details.run.recentActivity.map((item) => item.sequence)).toEqual(
            Array.from({ length: MAX_RECENT_ACTIVITY }, (_, index) => index + 8),
        );
        expect(isSubagentDetailsV1(details)).toBe(true);
    });

    test("rejects malformed and unknown protocol values", () => {
        const details = createInitialSubagentDetails({ id: "id", agent: "explore", model: "m", cwd: "/repo", now: 1 });
        expect(isSubagentDetailsV1({ ...details, version: 2 })).toBe(false);
        expect(isSubagentDetailsV1({ ...details, run: { ...details.run, activeTools: "bad" } })).toBe(false);
    });
});
