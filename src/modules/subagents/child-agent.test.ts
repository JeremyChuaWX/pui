import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    aggregateChildAgentUsage,
    type ChildAgentEvent,
    type ChildAgentState,
    getPiInvocation,
    runChildAgent,
} from "./child-agent.ts";
import { emptySubagentUsage } from "./job-state.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const cwd = path.dirname(fixture);

/** Limits with only the wall clock armed, so a real fixture process is bounded by one known timer. */
const wallClock = (wallClockMs: number) => ({ wallClockMs, stallTimeoutMs: 0, toolStallTimeoutMs: 0 });

async function runFixture(scenario: string, options: Partial<Parameters<typeof runChildAgent>[0]> = {}) {
    const events: ChildAgentEvent[] = [];
    const states: ChildAgentState[] = [];
    const result = await runChildAgent({
        command: process.execPath,
        args: [fixture, scenario],
        cwd,
        limits: wallClock(2_000),
        model: "fixture/model",
        throttleMs: 5,
        killGraceMs: 20,
        onFlush: (batch, state) => {
            events.push(...batch);
            states.push(state);
        },
        ...options,
    });
    return { result, events, states };
}

describe("runChildAgent", () => {
    test("streams fragmented JSONL, tracks parallel tools, and aggregates each assistant once", async () => {
        const { result, events, states } = await runFixture("success");

        expect(result.status).toBe("succeeded");
        expect(result.output).toBe("Final child report");
        expect(result.model).toBe("fixture/model");
        expect(result.usage).toEqual({
            input: 30,
            output: 6,
            cacheRead: 3,
            cacheWrite: 1,
            totalTokens: 40,
            cost: 0.03,
            turns: 2,
        });
        expect(events[0]?.kind).toBe("spawned");
        for (const kind of ["turn", "tool_start", "tool_end", "assistant"] as const) {
            expect(events.some((event) => event.kind === kind)).toBe(true);
        }
        expect(states.some((state) => state.activeTools.length === 2)).toBe(true);
        expect(states.some((state) => state.activeTools.length === 1 && state.activeTools[0]?.id === "tool-a")).toBe(
            true,
        );
    });

    test("retains every active tool internally and processes late end events", async () => {
        const { result, events, states } = await runFixture("tool-overflow", { throttleMs: 0 });

        expect(states.some((state) => state.activeTools.length === 65)).toBe(true);
        const afterEnd = states.find(
            (state) => state.activeTools.length === 64 && state.activeTools[0]?.id === "tool-1",
        );
        expect(afterEnd?.activeTools.at(-1)?.id).toBe("tool-64");
        expect(events.some((event) => event.kind === "tool_end" && event.title === "read 0")).toBe(true);
        expect(result.status).toBe("succeeded");
    });

    test("keeps the long model label through the terminal result", async () => {
        const { result } = await runFixture("success", { model: "fixture/model:off" });
        expect(result.model).toBe("fixture/model:off");
    });

    test("flushes the event-stream tail before resolving even under a long throttle", async () => {
        const { result, events } = await runFixture("malformed-success", { throttleMs: 60_000 });
        expect(result.status).toBe("succeeded");
        expect(result.output).toBe("recovered output");
        expect(events.some((event) => event.kind === "diagnostic" && event.title.includes("malformed"))).toBe(true);
        expect(events.some((event) => event.kind === "assistant")).toBe(true);
    });

    test("fails actionably when no final assistant response is emitted", async () => {
        const { result } = await runFixture("no-final");
        expect(result.status).toBe("failed");
        expect(result.error).toContain("without a final assistant response");
    });

    test("rejects an invalid finalized assistant message without crashing", async () => {
        const { result, events } = await runFixture("invalid-final");
        expect(result.status).toBe("failed");
        expect(result.error).toContain("without a final assistant response");
        expect(events.some((event) => event.kind === "diagnostic" && event.title.includes("invalid finalized"))).toBe(
            true,
        );
    });

    test("includes bounded stderr in nonzero-exit diagnostics", async () => {
        const { result } = await runFixture("failure");
        expect(result.status).toBe("failed");
        expect(result.error).toContain("exit code 7");
        expect(result.error).toContain("fixture child failed actionably");
    });

    test("distinguishes timeout from cancellation and reports each termination", async () => {
        const timedOut = await runFixture("hang", { limits: wallClock(25) });
        expect(timedOut.result.status).toBe("timed_out");
        expect(timedOut.result.error).toContain("wall clock");
        expect(
            timedOut.events.some((event) => event.kind === "diagnostic" && event.title === "Wall clock limit reached"),
        ).toBe(true);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const cancelled = await runFixture("hang", { limits: wallClock(5_000), signal: controller.signal });
        expect(cancelled.result.status).toBe("cancelled");
        expect(cancelled.result.error).toContain("cancelled");
        expect(
            cancelled.events.some((event) => event.kind === "diagnostic" && event.title === "Cancellation requested"),
        ).toBe(true);
    });

    test("returns a structured failure for a spawn error", async () => {
        const { result } = await runFixture("success", { command: path.join(cwd, "does-not-exist"), args: [] });
        expect(result.status).toBe("failed");
        expect(result.error).toContain("Unable to start child Pi");
    });
});

describe("aggregateChildAgentUsage", () => {
    test("aggregates missing, zero, and partial usage safely", () => {
        let usage = aggregateChildAgentUsage(emptySubagentUsage(), undefined);
        usage = aggregateChildAgentUsage(usage, {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: Number.NaN,
            totalTokens: 0,
            cost: { total: 0.25 },
        });
        usage = aggregateChildAgentUsage(usage, { output: 3, totalTokens: 20, cost: 0.5 }, 0);

        expect(usage).toEqual({
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 32,
            cost: 0.75,
            turns: 2,
        });
    });
});

describe("getPiInvocation", () => {
    test("does not reuse an SDK host entrypoint", () => {
        const invocation = getPiInvocation(["--mode", "json"], fixture, process.execPath);
        expect(invocation).toEqual({ command: "pi", args: ["--mode", "json"] });
    });

    test("does not reuse pui's compiled executable", () => {
        const invocation = getPiInvocation(["--mode", "json"], "/$bunfs/root/pui", "/Users/test/.local/bin/pui");
        expect(invocation).toEqual({ command: "pi", args: ["--mode", "json"] });
    });

    test("reuses Pi's standalone executable", () => {
        const invocation = getPiInvocation(["--mode", "json"], "/$bunfs/root/pi", "/Users/test/.local/bin/pi");
        expect(invocation).toEqual({
            command: "/Users/test/.local/bin/pi",
            args: ["--mode", "json"],
        });
    });

    test("reuses Pi's own CLI entrypoint", () => {
        const cli = path.join(
            cwd,
            "..",
            "..",
            "..",
            "..",
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "cli.js",
        );
        const invocation = getPiInvocation(["--mode", "json"], cli, "/usr/bin/node");
        expect(invocation).toEqual({ command: "/usr/bin/node", args: [cli, "--mode", "json"] });
    });
});
