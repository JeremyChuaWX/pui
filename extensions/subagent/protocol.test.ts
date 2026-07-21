import { describe, expect, test } from "bun:test";
import {
  MAX_RECENT_ACTIVITY,
  aggregateSubagentUsage,
  appendBoundedUtf8,
  appendSubagentActivity,
  createInitialSubagentDetails,
  createTerminalSubagentDetails,
  emptySubagentUsage,
  isSubagentDetailsV1,
  truncateUtf8,
  truncateUtf8Tail,
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

  test("aggregates missing, zero, and partial usage safely", () => {
    let usage = aggregateSubagentUsage(emptySubagentUsage(), undefined);
    usage = aggregateSubagentUsage(usage, {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: Number.NaN,
      totalTokens: 0,
      cost: { total: 0.25 },
    });
    usage = aggregateSubagentUsage(usage, { output: 3, totalTokens: 20, cost: 0.5 }, 0);

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

  test("truncates Unicode only at UTF-8 code-point boundaries", () => {
    const text = "A😀界B";
    expect(Buffer.byteLength(text, "utf8")).toBe(9);

    expect(truncateUtf8(text, 5)).toEqual({
      content: "A😀",
      truncated: true,
      outputBytes: 5,
      totalBytes: 9,
    });
    expect(truncateUtf8(text, 4).content).toBe("A");
    expect(truncateUtf8Tail(text, 5).content).toBe("界B");
    expect(appendBoundedUtf8("old-", "😀new", 7)).toBe("😀new");
    expect(truncateUtf8(text, 9).truncated).toBe(false);
  });

  test("rejects malformed and unknown protocol values", () => {
    const details = createInitialSubagentDetails({ id: "id", agent: "explore", model: "m", cwd: "/repo", now: 1 });
    expect(isSubagentDetailsV1({ ...details, version: 2 })).toBe(false);
    expect(isSubagentDetailsV1({ ...details, run: { ...details.run, activeTools: "bad" } })).toBe(false);
  });
});
