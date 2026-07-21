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
});
