import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type ToolExecutionEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

export interface ToolExecution {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ended";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  partialResult?: unknown;
  finalResult?: unknown;
  isError?: boolean;
}

export type ToolExecutionState = ReadonlyMap<string, ToolExecution>;

function recordArgs(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function reduceToolExecutions(
  state: ToolExecutionState,
  event: ToolExecutionEvent,
  now = Date.now(),
): ToolExecutionState {
  const next = new Map(state);
  const existing = state.get(event.toolCallId);

  switch (event.type) {
    case "tool_execution_start":
      next.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: recordArgs(event.args),
        status: "running",
        startedAt: now,
        updatedAt: now,
      });
      break;
    case "tool_execution_update":
      next.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: recordArgs(event.args),
        status: "running",
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        partialResult: event.partialResult,
      });
      break;
    case "tool_execution_end":
      next.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: existing?.args ?? {},
        status: "ended",
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        endedAt: now,
        partialResult: existing?.partialResult,
        finalResult: event.result,
        isError: event.isError,
      });
      break;
  }

  return next;
}

export interface ReconcileToolExecutionsOptions {
  pendingToolCallIds: ReadonlySet<string>;
  persistedToolCallIds: ReadonlySet<string>;
  settled?: boolean;
  now?: number;
}

/**
 * Reconcile event-derived state with Pi's public agent state and persisted messages.
 * Ended executions remain available until their tool-result message appears, avoiding
 * a blank frame between tool_execution_end and message persistence.
 */
export function reconcileToolExecutions(
  state: ToolExecutionState,
  options: ReconcileToolExecutionsOptions,
): ToolExecutionState {
  let next: Map<string, ToolExecution> | undefined;
  const mutable = () => (next ??= new Map(state));
  const now = options.now ?? Date.now();

  for (const [id, execution] of state) {
    if (execution.status === "ended" && options.persistedToolCallIds.has(id)) {
      mutable().delete(id);
      continue;
    }

    if (execution.status === "running" && !options.pendingToolCallIds.has(id)) {
      if (options.settled) {
        mutable().delete(id);
      } else {
        mutable().set(id, {
          ...execution,
          status: "ended",
          updatedAt: now,
          endedAt: now,
        });
      }
      continue;
    }

    if (options.settled && execution.status === "ended") mutable().delete(id);
  }

  return next ?? state;
}

export function runningToolExecutions(state: ToolExecutionState): ToolExecution[] {
  return [...state.values()]
    .filter((execution) => execution.status === "running")
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}
