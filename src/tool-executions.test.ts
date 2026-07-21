import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  deriveToolWorkingMessage,
  reconcileToolExecutions,
  reduceToolExecutions,
  runningToolExecutions,
  type ToolExecutionState,
} from "./tool-executions.js";

function reduce(state: ToolExecutionState, event: AgentSessionEvent, now: number): ToolExecutionState {
  if (
    event.type !== "tool_execution_start" &&
    event.type !== "tool_execution_update" &&
    event.type !== "tool_execution_end"
  ) {
    return state;
  }
  return reduceToolExecutions(state, event, now);
}

describe("tool execution reducer", () => {
  test("retains start arguments and the latest partial result", () => {
    let state: ToolExecutionState = new Map();
    state = reduce(
      state,
      { type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { path: "README.md" } },
      10,
    );
    const partialResult = { content: [{ type: "text", text: "partial" }], details: { progress: 1 } };
    state = reduce(
      state,
      {
        type: "tool_execution_update",
        toolCallId: "one",
        toolName: "read",
        args: { path: "README.md" },
        partialResult,
      },
      20,
    );

    expect(state.get("one")).toEqual(
      expect.objectContaining({
        args: { path: "README.md" },
        startedAt: 10,
        updatedAt: 20,
        partialResult,
        status: "running",
      }),
    );
  });

  test("keeps sibling tools independent when they finish out of order", () => {
    let state: ToolExecutionState = new Map();
    state = reduce(
      state,
      { type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { path: "one" } },
      10,
    );
    state = reduce(
      state,
      { type: "tool_execution_start", toolCallId: "two", toolName: "bash", args: { command: "sleep 1" } },
      11,
    );
    state = reduce(
      state,
      {
        type: "tool_execution_end",
        toolCallId: "two",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }], details: {} },
        isError: false,
      },
      20,
    );

    expect(state.get("two")?.status).toBe("ended");
    expect(runningToolExecutions(state).map((execution) => execution.id)).toEqual(["one"]);
    expect(deriveToolWorkingMessage(state)).toBe("Running read");
  });

  test("retains an ended execution until its persisted tool result is visible", () => {
    let state: ToolExecutionState = new Map();
    state = reduce(
      state,
      { type: "tool_execution_start", toolCallId: "one", toolName: "read", args: {} },
      10,
    );
    state = reduce(
      state,
      {
        type: "tool_execution_end",
        toolCallId: "one",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }], details: {} },
        isError: false,
      },
      20,
    );

    const waiting = reconcileToolExecutions(state, {
      pendingToolCallIds: new Set(),
      persistedToolCallIds: new Set(),
      now: 21,
    });
    expect(waiting.has("one")).toBe(true);

    const persisted = reconcileToolExecutions(waiting, {
      pendingToolCallIds: new Set(),
      persistedToolCallIds: new Set(["one"]),
      now: 22,
    });
    expect(persisted.has("one")).toBe(false);
  });

  test("uses pending calls as a safety check and only removes stale state on settlement", () => {
    let state: ToolExecutionState = new Map();
    state = reduce(
      state,
      { type: "tool_execution_start", toolCallId: "live", toolName: "read", args: {} },
      10,
    );
    state = reduce(
      state,
      { type: "tool_execution_start", toolCallId: "stale", toolName: "bash", args: {} },
      11,
    );

    const reconciled = reconcileToolExecutions(state, {
      pendingToolCallIds: new Set(["live"]),
      persistedToolCallIds: new Set(),
      settled: true,
      now: 30,
    });
    expect([...reconciled.keys()]).toEqual(["live"]);
    expect(reconciled.get("live")?.status).toBe("running");
  });
});
