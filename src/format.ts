import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeSubagentDetails, subagentPresentationKey } from "./subagent.js";
import type { ToolExecutionState } from "./tool-executions.js";
import type { DisplayItem } from "./types.js";

const MAX_TOOL_TEXT = 8_000;

type ToolDisplayItem = Extract<DisplayItem, { kind: "tool" }>;

export interface DisplayFormatOptions {
  toolExecutions?: ToolExecutionState;
}

function truncate(value: string, max = MAX_TOOL_TEXT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} more characters`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ("type" in part && part.type === "text" && "text" in part) return String(part.text);
      if ("type" in part && part.type === "image") {
        const mime = "mimeType" in part ? String(part.mimeType) : "image";
        return `[${mime}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function recordArgs(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resultDetails(value: unknown): unknown {
  return typeof value === "object" && value !== null && "details" in value
    ? (value as { details?: unknown }).details
    : undefined;
}

function resultContent(value: unknown): string {
  return typeof value === "object" && value !== null && "content" in value
    ? truncate(contentText((value as { content?: unknown }).content))
    : "";
}

function applySubagentPresentation(
  item: ToolDisplayItem,
  args: Record<string, unknown>,
  timestamp?: number,
): void {
  const preferredDetails = item.running
    ? item.partialDetails ?? item.resultDetails
    : item.resultDetails !== undefined
      ? item.resultDetails
      : item.partialDetails;
  const subagent = normalizeSubagentDetails(preferredDetails, {
    toolCallId: item.toolCallId,
    args,
    running: item.running,
    isError: item.isError,
    timestamp,
    error: item.isError ? item.result : undefined,
  });
  if (subagent) {
    item.subagent = subagent;
    item.subagentKey = subagentPresentationKey(subagent);
  } else {
    delete item.subagent;
    delete item.subagentKey;
  }
}

export function formatToolTitle(name: string, args: Record<string, unknown> = {}): string {
  const target =
    args.path ?? args.file_path ?? args.filePath ?? args.command ?? args.query ?? args.pattern ?? args.url ?? args.input;
  if (typeof target !== "string" || target.length === 0) return name;
  const oneLine = target.replace(/\s+/g, " ").trim();
  return `${name}  ${oneLine.length > 76 ? `${oneLine.slice(0, 73)}…` : oneLine}`;
}

export function formatToolArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";

  if (typeof args.command === "string") return `$ ${truncate(args.command, 2_000)}`;
  if (typeof args.path === "string" && entries.length === 1) return args.path;
  if (typeof args.url === "string" && entries.length === 1) return args.url;
  return truncate(safeJson(args));
}

export function formatCount(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function buildDisplayItems(
  messages: AgentMessage[],
  streamingMessage?: AgentMessage,
  options: DisplayFormatOptions = {},
): DisplayItem[] {
  const source = [...messages];
  if (streamingMessage && !source.includes(streamingMessage)) source.push(streamingMessage);

  const result: DisplayItem[] = [];
  const toolById = new Map<string, ToolDisplayItem>();
  const argsById = new Map<string, Record<string, unknown>>();
  const executions = options.toolExecutions ?? new Map();

  source.forEach((message, messageIndex) => {
    const id = `${messageIndex}:${message.timestamp ?? messageIndex}`;

    switch (message.role) {
      case "user": {
        const text = contentText(message.content);
        if (text) result.push({ id, kind: "user", text });
        break;
      }
      case "assistant": {
        message.content.forEach((part, partIndex) => {
          const partId = `${id}:${partIndex}`;
          if (part.type === "text" && part.text) {
            result.push({
              id: partId,
              kind: "assistant",
              text: part.text,
              streaming: streamingMessage === message,
            });
            return;
          }
          if (part.type === "thinking" && part.thinking) {
            result.push({ id: partId, kind: "thinking", text: part.thinking, streaming: streamingMessage === message });
            return;
          }
          if (part.type === "toolCall") {
            const args = recordArgs(part.arguments);
            const execution = executions.get(part.id);
            const liveResult = execution?.status === "ended" ? execution.finalResult : execution?.partialResult;
            const item: ToolDisplayItem = {
              id: partId,
              kind: "tool",
              toolCallId: part.id,
              name: part.name,
              title: formatToolTitle(part.name, args),
              args: formatToolArguments(args),
              running: execution?.status === "running",
              ...(execution?.partialResult === undefined
                ? {}
                : { partialDetails: resultDetails(execution.partialResult) }),
              ...(execution?.finalResult === undefined
                ? {}
                : { resultDetails: resultDetails(execution.finalResult) }),
              ...(liveResult === undefined || resultContent(liveResult) === ""
                ? {}
                : { result: resultContent(liveResult) }),
              ...(execution?.isError === undefined ? {} : { isError: execution.isError }),
            };
            applySubagentPresentation(item, args, execution?.updatedAt ?? message.timestamp);
            result.push(item);
            toolById.set(part.id, item);
            argsById.set(part.id, args);
          }
        });
        if (message.errorMessage) {
          result.push({ id: `${id}:error`, kind: "custom", label: "error", text: message.errorMessage });
        }
        break;
      }
      case "toolResult": {
        const output = truncate(contentText(message.content));
        const existing = toolById.get(message.toolCallId);
        if (existing) {
          existing.result = output;
          existing.isError = message.isError;
          existing.running = false;
          existing.resultDetails = message.details;
          applySubagentPresentation(existing, argsById.get(message.toolCallId) ?? {}, message.timestamp);
        } else {
          const item: ToolDisplayItem = {
            id,
            kind: "tool",
            toolCallId: message.toolCallId,
            name: message.toolName,
            title: message.toolName,
            args: "",
            result: output,
            isError: message.isError,
            running: false,
            resultDetails: message.details,
          };
          applySubagentPresentation(item, {}, message.timestamp);
          result.push(item);
          toolById.set(message.toolCallId, item);
        }
        break;
      }
      case "bashExecution":
        result.push({
          id,
          kind: "bash",
          command: message.command,
          output: truncate(message.output),
          exitCode: message.exitCode,
          cancelled: message.cancelled,
          excluded: Boolean(message.excludeFromContext),
        });
        break;
      case "custom":
        if (message.display) {
          result.push({ id, kind: "custom", label: message.customType, text: contentText(message.content) });
        }
        break;
      case "branchSummary":
        result.push({ id, kind: "summary", label: "branch summary", text: message.summary });
        break;
      case "compactionSummary":
        result.push({ id, kind: "summary", label: "compacted context", text: message.summary });
        break;
    }
  });

  for (const execution of executions.values()) {
    if (toolById.has(execution.id)) continue;
    const liveResult = execution.status === "ended" ? execution.finalResult : execution.partialResult;
    const item: ToolDisplayItem = {
      id: `tool-execution:${execution.id}`,
      kind: "tool",
      toolCallId: execution.id,
      name: execution.name,
      title: formatToolTitle(execution.name, execution.args),
      args: formatToolArguments(execution.args),
      running: execution.status === "running",
      ...(execution.partialResult === undefined ? {} : { partialDetails: resultDetails(execution.partialResult) }),
      ...(execution.finalResult === undefined ? {} : { resultDetails: resultDetails(execution.finalResult) }),
      ...(liveResult === undefined || resultContent(liveResult) === "" ? {} : { result: resultContent(liveResult) }),
      ...(execution.isError === undefined ? {} : { isError: execution.isError }),
    };
    applySubagentPresentation(item, execution.args, execution.updatedAt);
    result.push(item);
  }

  return result;
}
