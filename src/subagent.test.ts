import { describe, expect, test } from "bun:test";
import {
  formatElapsed,
  compactSubagentUsage,
  normalizeSubagentDetails,
  subagentElapsed,
  subagentStatusIcon,
  subagentSummary,
} from "./subagent.js";

function protocolDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "pi.subagent",
    version: 1,
    run: {
      id: "outer-1",
      agent: "explore",
      model: "openai/gpt-5.4-mini",
      cwd: "/repo",
      status: "running",
      phase: "tool",
      startedAt: 1_000,
      updatedAt: 2_000,
      activeTools: [{ id: "child-1", name: "read", title: "read src/controller.ts", startedAt: 1_500 }],
      recentActivity: [
        { sequence: 1, timestamp: 1_000, kind: "turn", title: "Turn 1" },
        { sequence: 2, timestamp: 1_500, kind: "tool_start", title: "read src/controller.ts" },
      ],
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60, cost: 0.0012, turns: 1 },
      outputPreview: "Working output",
      ...overrides,
    },
  };
}

describe("subagent detail normalization", () => {
  test("normalizes a live protocol snapshot and outer call arguments", () => {
    const view = normalizeSubagentDetails(protocolDetails(), {
      toolCallId: "outer-1",
      running: true,
      args: { prompt: "Inspect controller state", cwd: "/repo" },
    });

    expect(view).toEqual(
      expect.objectContaining({
        source: "protocol-v1",
        id: "outer-1",
        agent: "explore",
        status: "running",
        prompt: "Inspect controller state",
        activeTools: [expect.objectContaining({ title: "read src/controller.ts" })],
      }),
    );
    expect(subagentSummary(view!, 13_000)).toContain("read src/controller.ts");
  });

  test("recreates terminal protocol state and uses stable elapsed time", () => {
    const view = normalizeSubagentDetails(
      protocolDetails({
        status: "succeeded",
        phase: "exiting",
        activeTools: [],
        endedAt: 15_000,
        usage: { input: 10_000, output: 8_000, cacheRead: 400, cacheWrite: 0, totalTokens: 18_400, cost: 0.0123, turns: 3 },
      }),
      { toolCallId: "outer-1" },
    );

    expect(view?.status).toBe("succeeded");
    expect(subagentElapsed(view!, 99_000)).toBe("14s");
    expect(subagentSummary(view!, 99_000)).toBe(
      "explore · openai/gpt-5.4-mini · 14s · 3 turns · 18k tokens",
    );
    expect(compactSubagentUsage(view!.usage)).toBe("3 turns · 18k tokens");
    expect(compactSubagentUsage(view!.usage)).not.toContain("$");
  });

  test("adapts legacy persisted details", () => {
    const view = normalizeSubagentDetails(
      {
        agent: "explore",
        model: "anthropic/claude-sonnet",
        toolCalls: ["read README.md", "grep reducer in src"],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.01 },
      },
      {
        toolCallId: "legacy-1",
        args: { prompt: "Review the project", cwd: "/repo" },
        isError: false,
        timestamp: 4_000,
      },
    );

    expect(view).toEqual(
      expect.objectContaining({
        source: "legacy",
        id: "legacy-1",
        status: "succeeded",
        cwd: "/repo",
        prompt: "Review the project",
      }),
    );
    expect(view?.recentActivity.map((activity) => activity.title)).toEqual([
      "read README.md",
      "grep reducer in src",
    ]);
  });

  test("rejects malformed payloads, mismatched ids, and unknown versions", () => {
    expect(normalizeSubagentDetails({ ...protocolDetails(), version: 2 })).toBeUndefined();
    expect(normalizeSubagentDetails(protocolDetails(), { toolCallId: "different" })).toBeUndefined();
    expect(normalizeSubagentDetails(protocolDetails({ recentActivity: "bad" }))).toBeUndefined();
    expect(
      normalizeSubagentDetails({ agent: "explore", toolCalls: [1], usage: {} }),
    ).toBeUndefined();
  });

  test("formats status-specific timing labels", () => {
    expect(formatElapsed(125_000)).toBe("2m 5s");
    expect(subagentStatusIcon("cancelled")).toBe("⊘");
    expect(subagentStatusIcon("timed_out")).toBe("⧖");
  });
});
