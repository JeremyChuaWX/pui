import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DisplayItem } from "./types.js";

const MAX_TOOL_TEXT = 8_000;

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

export function buildDisplayItems(messages: AgentMessage[], streamingMessage?: AgentMessage): DisplayItem[] {
  const source = [...messages];
  if (streamingMessage && !source.includes(streamingMessage)) source.push(streamingMessage);

  const result: DisplayItem[] = [];
  const toolById = new Map<string, Extract<DisplayItem, { kind: "tool" }>>();

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
            const item: Extract<DisplayItem, { kind: "tool" }> = {
              id: partId,
              kind: "tool",
              toolCallId: part.id,
              name: part.name,
              title: formatToolTitle(part.name, part.arguments),
              args: formatToolArguments(part.arguments),
              running: streamingMessage === message,
            };
            result.push(item);
            toolById.set(part.id, item);
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
        } else {
          result.push({
            id,
            kind: "tool",
            toolCallId: message.toolCallId,
            name: message.toolName,
            title: message.toolName,
            args: "",
            result: output,
            isError: message.isError,
          });
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

  return result;
}
