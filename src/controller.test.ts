import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PiTuiController } from "./controller.js";

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function details(id: string, status: "queued" | "running" | "succeeded" | "failed") {
  const terminal = status === "succeeded" || status === "failed";
  return {
    schema: "pi.subagent",
    version: 1,
    run: {
      id,
      agent: "explore",
      model: "fixture/model",
      cwd: process.cwd(),
      status,
      phase: status === "queued" ? "queued" : terminal ? "exiting" : "thinking",
      ...(status === "queued" ? {} : { startedAt: 10 }),
      updatedAt: 20,
      ...(terminal ? { endedAt: 30 } : {}),
      activeTools: [],
      recentActivity: [],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 },
      ...(status === "failed" ? { error: "fixture failure" } : {}),
    },
  };
}

function assistantCalls(ids: string[]): AgentMessage {
  return {
    role: "assistant",
    content: ids.map((id) => ({
      type: "toolCall" as const,
      id,
      name: "delegator",
      arguments: { agent: "explore", prompt: `Inspect ${id}`, cwd: process.cwd() },
    })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fixture",
    usage: usage(),
    stopReason: "toolUse",
    timestamp: 1,
  } as AgentMessage;
}

interface FakeSessionState {
  messages: AgentMessage[];
  pending: Set<string>;
  isStreaming: boolean;
}

function createController(messages: AgentMessage[]): {
  controller: PiTuiController;
  state: FakeSessionState;
  emit: (event: AgentSessionEvent) => void;
} {
  const state: FakeSessionState = { messages, pending: new Set(), isStreaming: true };
  const session = {
    get messages() {
      return state.messages;
    },
    agent: {
      state: {
        get streamingMessage() {
          return undefined;
        },
        get pendingToolCalls() {
          return state.pending;
        },
      },
    },
    getContextUsage: () => undefined,
    sessionId: "fixture-session",
    sessionFile: undefined,
    sessionName: undefined,
    model: { id: "fixture-model", provider: "fixture" },
    thinkingLevel: "off",
    get isStreaming() {
      return state.isStreaming;
    },
    isCompacting: false,
    isRetrying: false,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => ["read", "delegator"],
  };
  const runtime = {
    cwd: process.cwd(),
    session,
    setRebindSession: () => {},
    dispose: async () => {},
  } as unknown as AgentSessionRuntime;
  const Controller = PiTuiController as unknown as new (runtime: AgentSessionRuntime) => PiTuiController;
  const controller = new Controller(runtime);
  const emit = (event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") state.pending.add(event.toolCallId);
    if (event.type === "tool_execution_end") state.pending.delete(event.toolCallId);
    (controller as unknown as { handleEvent: (next: AgentSessionEvent) => void }).handleEvent(event);
  };
  return { controller, state, emit };
}

describe("PiTuiController tool event path", () => {
  test("transports partial subagent snapshots and preserves a running sibling", async () => {
    const ids = ["slow", "fast"];
    const { controller, state, emit } = createController([assistantCalls(ids)]);

    for (const id of ids) {
      const args = { agent: "explore", prompt: `Inspect ${id}`, cwd: process.cwd() };
      emit({ type: "tool_execution_start", toolCallId: id, toolName: "delegator", args });
      emit({
        type: "tool_execution_update",
        toolCallId: id,
        toolName: "delegator",
        args,
        partialResult: { content: [{ type: "text", text: "queued" }], details: details(id, "queued") },
      });
    }
    await Bun.sleep(25);

    let snapshot = controller.snapshot();
    expect(snapshot.activeTools.map((tool) => tool.id).sort()).toEqual([...ids].sort());
    expect(snapshot.workingMessage).toBe("Running 2 tools");
    expect(
      snapshot.display
        .filter((item) => item.kind === "tool")
        .map((item) => [item.toolCallId, item.subagent?.status]),
    ).toEqual([
      ["slow", "queued"],
      ["fast", "queued"],
    ]);

    emit({
      type: "tool_execution_end",
      toolCallId: "fast",
      toolName: "delegator",
      result: {
        content: [{ type: "text", text: "fixture failure" }],
        details: details("fast", "failed"),
      },
      isError: true,
    });
    snapshot = controller.snapshot();
    expect(snapshot.activeTools.map((tool) => tool.id)).toEqual(["slow"]);
    expect(snapshot.workingMessage).toBe("Running delegator");
    expect(
      snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast"),
    ).toEqual(expect.objectContaining({ subagent: expect.objectContaining({ status: "failed" }) }));

    state.messages.push({
      role: "toolResult",
      toolCallId: "fast",
      toolName: "delegator",
      content: [{ type: "text", text: "fixture failure" }],
      details: details("fast", "failed"),
      isError: true,
      timestamp: 2,
    } as AgentMessage);
    emit({
      type: "tool_execution_end",
      toolCallId: "slow",
      toolName: "delegator",
      result: { content: [{ type: "text", text: "done" }], details: details("slow", "succeeded") },
      isError: false,
    });
    snapshot = controller.snapshot();
    expect(snapshot.activeTools).toEqual([]);
    expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast")).toEqual(
      expect.objectContaining({ resultDetails: expect.objectContaining({ schema: "pi.subagent" }) }),
    );

    state.messages.push({
      role: "toolResult",
      toolCallId: "slow",
      toolName: "delegator",
      content: [{ type: "text", text: "done" }],
      details: details("slow", "succeeded"),
      isError: false,
      timestamp: 3,
    } as AgentMessage);
    state.isStreaming = false;
    emit({ type: "agent_settled" });
    snapshot = controller.snapshot();
    expect(snapshot.workingMessage).toBeUndefined();
    expect(
      snapshot.display
        .filter((item) => item.kind === "tool")
        .map((item) => [item.toolCallId, item.subagent?.status]),
    ).toEqual([
      ["slow", "succeeded"],
      ["fast", "failed"],
    ]);

    await controller.dispose();
  });

  test("keeps extension-free generic tool updates generic", async () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "fixture",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: 1,
    } as AgentMessage;
    const { controller, emit } = createController([call]);
    emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
    emit({
      type: "tool_execution_update",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
      partialResult: { content: [{ type: "text", text: "partial read" }], details: { lines: 1 } },
    });
    await Bun.sleep(25);

    expect(controller.snapshot().display[0]).toEqual(
      expect.objectContaining({ kind: "tool", name: "read", running: true, result: "partial read" }),
    );
    const item = controller.snapshot().display[0];
    expect(item && item.kind === "tool" ? item.subagent : undefined).toBeUndefined();
    await controller.dispose();
  });
});
