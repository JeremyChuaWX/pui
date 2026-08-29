import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createInitialSubagentRun,
    isSubagentRunV1,
    MAX_SUBAGENT_ACTIVE_TOOLS,
    type SubagentRunV1,
    updateSubagentRun,
} from "./run-state.ts";
import { runSubagent } from "./runner.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const cwd = path.dirname(fixture);

function startingRun(id = "outer-id"): SubagentRunV1 {
    const initial = createInitialSubagentRun({
        id,
        agent: "explore",
        model: "fixture/model",
        cwd,
        now: Date.now(),
    });
    return updateSubagentRun(initial, { status: "starting", phase: "spawning", startedAt: Date.now() });
}

async function runFixture(scenario: string, options: Partial<Parameters<typeof runSubagent>[0]> = {}) {
    const snapshots: SubagentRunV1[] = [];
    const result = await runSubagent({
        run: startingRun(),
        command: process.execPath,
        args: [fixture, scenario],
        cwd,
        timeoutMs: 2_000,
        throttleMs: 5,
        killGraceMs: 20,
        onSnapshot: (run) => snapshots.push(run),
        ...options,
    });
    return { result, snapshots };
}

describe("runSubagent", () => {
    test("streams fragmented JSONL, tracks parallel tools, and aggregates each assistant once", async () => {
        const { result, snapshots } = await runFixture("success");

        expect(result.run.status).toBe("succeeded");
        expect(result.output).toBe("Final child report");
        expect(result.run.model).toBe("fixture/model");
        expect(result.run.usage).toEqual({
            input: 30,
            output: 6,
            cacheRead: 3,
            cacheWrite: 1,
            totalTokens: 40,
            cost: 0.03,
            turns: 2,
        });
        expect(snapshots.some((item) => item.activeTools.length === 2)).toBe(true);
        expect(snapshots.some((item) => item.activeTools.length === 1 && item.activeTools[0]?.id === "tool-a")).toBe(
            true,
        );
        expect(result.run.activeTools).toEqual([]);
        expect(snapshots.at(-1)?.status).toBe("succeeded");
    });

    test("bounds snapshots while retaining omitted tools through their end events", async () => {
        const { result, snapshots } = await runFixture("tool-overflow", { throttleMs: 0 });
        const full = snapshots.find((item) => item.activeTools.at(-1)?.id === "tool-64");

        expect(snapshots.every(isSubagentRunV1)).toBe(true);
        expect(snapshots.every((item) => item.activeTools.length <= MAX_SUBAGENT_ACTIVE_TOOLS)).toBe(true);
        expect(full?.activeTools[0]?.id).toBe("tool-1");
        expect(full?.activeTools.at(-1)?.id).toBe("tool-64");
        expect(
            snapshots.some(
                (item) =>
                    item.recentActivity.at(-1)?.kind === "tool_end" &&
                    item.activeTools.length === MAX_SUBAGENT_ACTIVE_TOOLS &&
                    item.phase === "tool",
            ),
        ).toBe(true);
        expect(result.run.status).toBe("succeeded");
        expect(result.run.activeTools).toEqual([]);
    });

    test("keeps the long model label through the final terminal snapshot", async () => {
        const run = startingRun();
        run.model = "fixture/model:off";
        const { result, snapshots } = await runFixture("success", { run });

        expect(snapshots.at(-1)?.status).toBe("succeeded");
        expect(snapshots.at(-1)?.model).toBe("fixture/model:off");
        expect(result.run.model).toBe("fixture/model:off");
    });

    test("keeps malformed output as a bounded diagnostic without crashing", async () => {
        const { result } = await runFixture("malformed-success");
        expect(result.run.status).toBe("succeeded");
        expect(result.output).toBe("recovered output");
        expect(
            result.run.recentActivity.some((item) => item.kind === "diagnostic" && item.title.includes("malformed")),
        ).toBe(true);
    });

    test("fails actionably when no final assistant response is emitted", async () => {
        const { result } = await runFixture("no-final");
        expect(result.run.status).toBe("failed");
        expect(result.run.error).toContain("without a final assistant response");
    });

    test("rejects an invalid finalized assistant message without crashing", async () => {
        const { result } = await runFixture("invalid-final");
        expect(result.run.status).toBe("failed");
        expect(result.run.error).toContain("without a final assistant response");
        expect(result.run.recentActivity.some((item) => item.title.includes("invalid finalized"))).toBe(true);
    });

    test("includes bounded stderr in nonzero-exit diagnostics", async () => {
        const { result } = await runFixture("failure");
        expect(result.run.status).toBe("failed");
        expect(result.run.error).toContain("exit code 7");
        expect(result.run.error).toContain("fixture child failed actionably");
    });

    test("distinguishes timeout from user cancellation and force-kills stubborn children", async () => {
        const timedOut = await runFixture("hang", { timeoutMs: 25 });
        expect(timedOut.result.run.status).toBe("timed_out");
        expect(timedOut.result.run.error).toContain("timed out");

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const cancelled = await runFixture("hang", { timeoutMs: 5_000, signal: controller.signal });
        expect(cancelled.result.run.status).toBe("cancelled");
        expect(cancelled.result.run.error).toContain("cancelled");
    });

    test("kills descendants in the child process group on timeout", async () => {
        const { result } = await runFixture("descendant-hang", { timeoutMs: 500 });
        const pid = Number(result.stderr.match(/descendant:(\d+)/)?.[1]);
        expect(result.run.status).toBe("timed_out");
        expect(pid).toBeGreaterThan(0);

        let alive = true;
        for (let attempt = 0; attempt < 50 && alive; attempt++) {
            try {
                process.kill(pid, 0);
                await Bun.sleep(10);
            } catch {
                alive = false;
            }
        }
        expect(alive).toBe(false);
    });

    test("bounds stderr and emits no progress after settlement", async () => {
        const snapshots: SubagentRunV1[] = [];
        const { result } = await runFixture("large-stderr-failure", {
            onSnapshot: (run) => snapshots.push(run),
        });
        const countAtSettlement = snapshots.length;
        await Bun.sleep(30);

        expect(result.run.status).toBe("failed");
        expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(16 * 1024);
        expect(snapshots).toHaveLength(countAtSettlement);
    });

    test("ignores progress callback errors without stranding the child", async () => {
        const { result } = await runFixture("success", {
            onSnapshot: () => {
                throw new Error("renderer failed");
            },
        });
        expect(result.run.status).toBe("succeeded");
        expect(result.output).toBe("Final child report");
    });

    test("returns structured failure for a spawn error", async () => {
        const { result } = await runSubagent({
            run: startingRun(),
            command: path.join(cwd, "does-not-exist"),
            args: [],
            cwd,
            timeoutMs: 100,
        }).then((result) => ({ result }));
        expect(result.run.status).toBe("failed");
        expect(result.run.error).toContain("Unable to start child Pi");
    });
});
