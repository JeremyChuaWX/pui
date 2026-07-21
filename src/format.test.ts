import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildDisplayItems, formatCount, formatToolTitle } from "./format.js";

describe("Pi OpenTUI formatting", () => {
  test("combines a tool call with its result", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "# Dotfiles" }],
        isError: false,
        timestamp: 2,
      },
    ] as AgentMessage[];

    expect(buildDisplayItems(messages)).toEqual([
      expect.objectContaining({ kind: "tool", title: "read  README.md", result: "# Dotfiles", isError: false }),
    ]);
  });

  test("keeps an assistant block identity stable when streaming completes", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "## Stable heading" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 42,
    } as AgentMessage;

    const streaming = buildDisplayItems([], message)[0];
    const completed = buildDisplayItems([message])[0];
    expect(streaming?.id).toBe(completed?.id);
    expect(streaming).toEqual(expect.objectContaining({ kind: "assistant", streaming: true }));
    expect(completed).toEqual(expect.objectContaining({ kind: "assistant", streaming: false }));
  });

  test("formats compact token counts and tool labels", () => {
    expect(formatCount(1_250)).toBe("1.3k");
    expect(formatToolTitle("bash", { command: "git status" })).toBe("bash  git status");
  });

  test("prefers live partial subagent details and reducer-derived running state", () => {
    const call = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "sub-1",
          name: "delegator",
          arguments: { agent: "explore", prompt: "Inspect the reducer", cwd: "/repo" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    } as AgentMessage;
    const details = subagentDetails("sub-1", "running");
    const display = buildDisplayItems([call], undefined, {
      toolExecutions: new Map([
        [
          "sub-1",
          {
            id: "sub-1",
            name: "delegator",
            args: { agent: "explore", prompt: "Inspect the reducer", cwd: "/repo" },
            status: "running",
            startedAt: 10,
            updatedAt: 20,
            partialResult: { content: [{ type: "text", text: "running" }], details },
          },
        ],
      ]),
    });

    expect(display[0]).toEqual(
      expect.objectContaining({
        kind: "tool",
        running: true,
        partialDetails: details,
        subagent: expect.objectContaining({ status: "running", prompt: "Inspect the reducer" }),
      }),
    );
  });

  test("restores completed subagent presentation from persisted result details", () => {
    const messages = toolMessages("resume-1", subagentDetails("resume-1", "timed_out"), true);
    const item = buildDisplayItems(messages)[0];

    expect(item).toEqual(
      expect.objectContaining({
        kind: "tool",
        running: false,
        isError: true,
        resultDetails: expect.objectContaining({ schema: "pi.subagent", version: 1 }),
        subagent: expect.objectContaining({ id: "resume-1", status: "timed_out" }),
      }),
    );
  });

  test("adapts legacy sessions and falls back for unknown protocol versions", () => {
    const legacy = {
      agent: "explore",
      model: "test/model",
      toolCalls: ["read README.md"],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 },
    };
    const legacyItem = buildDisplayItems(toolMessages("legacy-1", legacy, false))[0];
    expect(legacyItem).toEqual(
      expect.objectContaining({ kind: "tool", subagent: expect.objectContaining({ source: "legacy" }) }),
    );

    const unknownItem = buildDisplayItems(
      toolMessages("future-1", { ...subagentDetails("future-1", "succeeded"), version: 2 }, false),
    )[0];
    expect(unknownItem).toEqual(expect.objectContaining({ kind: "tool", result: "delegated output" }));
    expect(unknownItem && "subagent" in unknownItem ? unknownItem.subagent : undefined).toBeUndefined();
  });
});

function subagentDetails(id: string, status: "running" | "succeeded" | "timed_out"): Record<string, unknown> {
  const terminal = status !== "running";
  return {
    schema: "pi.subagent",
    version: 1,
    run: {
      id,
      agent: "explore",
      model: "test/model",
      cwd: "/repo",
      status,
      phase: terminal ? "exiting" : "thinking",
      startedAt: 10,
      updatedAt: 20,
      ...(terminal ? { endedAt: 30 } : {}),
      activeTools: [],
      recentActivity: [],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 },
      ...(status === "timed_out" ? { error: "Timed out after 120s" } : {}),
    },
  };
}

function toolMessages(id: string, details: unknown, isError: boolean): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: "delegator",
          arguments: { agent: "explore", prompt: "Inspect the repository", cwd: "/repo" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "delegator",
      content: [{ type: "text", text: "delegated output" }],
      details,
      isError,
      timestamp: 2,
    },
  ] as AgentMessage[];
}
