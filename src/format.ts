import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    MAX_WORKFLOW_ID,
    parseWorkflowRunV1,
    type WorkflowAgentStatus,
    type WorkflowRunStatus,
    type WorkflowRunSummaryV1,
} from "../extensions/workflow/protocol.js";
import { normalizeSubagentDetails, subagentPresentationKey } from "./subagent.js";
import type { ToolExecution, ToolExecutionState } from "./tool-executions.js";
import type { DisplayItem } from "./types.js";

const MAX_TOOL_TEXT = 8_000;

const WORKFLOW_STATUS_PRESENTATION: Record<WorkflowRunStatus | WorkflowAgentStatus, { icon: string; label: string }> = {
    queued: { icon: "·", label: "Queued" },
    running: { icon: "◌", label: "Running" },
    paused: { icon: "Ⅱ", label: "Paused" },
    succeeded: { icon: "✓", label: "Succeeded" },
    failed: { icon: "×", label: "Failed" },
    cancelled: { icon: "■", label: "Stopped" },
    timed_out: { icon: "×", label: "Timed out" },
};

export function workflowStatusPresentation(status: WorkflowRunStatus | WorkflowAgentStatus) {
    return WORKFLOW_STATUS_PRESENTATION[status];
}

export function workflowStatusTone(
    status: WorkflowRunStatus | WorkflowAgentStatus,
): "success" | "error" | "warning" | "muted" | "info" {
    if (status === "succeeded") return "success";
    if (status === "failed" || status === "timed_out") return "error";
    if (status === "running" || status === "paused") return "warning";
    return status === "queued" || status === "cancelled" ? "muted" : "info";
}

export function formatWorkflowSummary(run: WorkflowRunSummaryV1): string {
    const state = workflowStatusPresentation(run.status);
    const done = run.agents.filter((agent) =>
        ["succeeded", "failed", "cancelled", "timed_out"].includes(agent.status),
    ).length;
    return `${state.icon} ${run.name} · ${state.label} · ${done}/${run.agents.length} agents${run.currentPhase ? ` · ${run.currentPhase}` : ""}`;
}

type ToolDisplayItem = Extract<DisplayItem, { kind: "tool" }>;

interface DisplayFormatOptions {
    toolExecutions?: ToolExecutionState;
    workflows?: readonly WorkflowRunSummaryV1[];
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

function toolResultDetails(value: unknown): unknown {
    return typeof value === "object" && value !== null && "details" in value
        ? (value as { details?: unknown }).details
        : undefined;
}

function resultContent(value: unknown): string {
    return typeof value === "object" && value !== null && "content" in value
        ? truncate(contentText((value as { content?: unknown }).content))
        : "";
}

function workflowLaunchRunId(details: unknown): string | undefined {
    if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
    const launch = details as Record<string, unknown>;
    return launch.schema === "pi.workflow.launch" &&
        launch.version === 1 &&
        typeof launch.runId === "string" &&
        launch.runId.length > 0 &&
        launch.runId.length <= MAX_WORKFLOW_ID
        ? launch.runId
        : undefined;
}

export function resolveWorkflowRun(
    details: unknown,
    workflows: readonly WorkflowRunSummaryV1[] = [],
): { run?: WorkflowRunSummaryV1; runId?: string } {
    const envelope =
        details && typeof details === "object" && !Array.isArray(details) && "run" in details
            ? (details as Record<string, unknown>)
            : undefined;
    const candidate =
        envelope?.schema === "pi.workflow" && envelope.version === 1 ? envelope.run : envelope ? undefined : details;
    const embedded = parseWorkflowRunV1(candidate);
    if (embedded) return { run: embedded, runId: embedded.id };
    const runId = workflowLaunchRunId(details);
    return { run: runId ? workflows.find((run) => run.id === runId) : undefined, runId };
}

function applyWorkflowPresentation(
    item: ToolDisplayItem,
    details: unknown,
    workflows: readonly WorkflowRunSummaryV1[] = [],
): void {
    const { run, runId } = resolveWorkflowRun(details, workflows);
    if (runId) item.workflowRunId = runId;
    else delete item.workflowRunId;
    if (!run) {
        delete item.workflow;
        item.workflowKey = runId;
        return;
    }
    item.workflow = run;
    item.workflowKey = `${runId}:${run.updatedAt}:${run.status}`;
}

function applySubagentPresentation(item: ToolDisplayItem, details: unknown, args: Record<string, unknown>): void {
    const subagent = normalizeSubagentDetails(details, {
        toolCallId: item.toolCallId,
        args,
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
        args.path ??
        args.file_path ??
        args.filePath ??
        args.command ??
        args.query ??
        args.pattern ??
        args.url ??
        args.input;
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

function executionDetails(execution?: ToolExecution): unknown {
    const partialDetails = toolResultDetails(execution?.partialResult);
    const finalDetails = toolResultDetails(execution?.finalResult);
    return execution?.status === "running"
        ? partialDetails !== undefined
            ? partialDetails
            : finalDetails
        : finalDetails !== undefined
          ? finalDetails
          : partialDetails;
}

function buildToolDisplayItem(
    id: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    execution?: ToolExecution,
    workflows: readonly WorkflowRunSummaryV1[] = [],
): ToolDisplayItem {
    const liveResult = execution?.status === "ended" ? execution.finalResult : execution?.partialResult;
    const details = executionDetails(execution);
    const item: ToolDisplayItem = {
        id,
        kind: "tool",
        toolCallId,
        name,
        title: formatToolTitle(name, args),
        args: formatToolArguments(args),
        running: execution?.status === "running",
        ...(liveResult === undefined || resultContent(liveResult) === "" ? {} : { result: resultContent(liveResult) }),
        ...(execution?.isError === undefined ? {} : { isError: execution.isError }),
    };
    applySubagentPresentation(item, details, args);
    applyWorkflowPresentation(item, details, workflows);
    return item;
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
    const detailsById = new Map<string, unknown>();
    const executions = options.toolExecutions ?? new Map();
    const workflows = options.workflows ?? [];

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
                        result.push({
                            id: partId,
                            kind: "thinking",
                            text: part.thinking,
                            streaming: streamingMessage === message,
                        });
                        return;
                    }
                    if (part.type === "toolCall") {
                        const args = recordArgs(part.arguments);
                        const item = buildToolDisplayItem(
                            partId,
                            part.id,
                            part.name,
                            args,
                            executions.get(part.id),
                            workflows,
                        );
                        result.push(item);
                        toolById.set(part.id, item);
                        argsById.set(part.id, args);
                        detailsById.set(part.id, executionDetails(executions.get(part.id)));
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
                    const details =
                        message.details !== undefined ? message.details : detailsById.get(message.toolCallId);
                    applySubagentPresentation(existing, details, argsById.get(message.toolCallId) ?? {});
                    applyWorkflowPresentation(existing, details, workflows);
                } else {
                    const item = buildToolDisplayItem(id, message.toolCallId, message.toolName, {});
                    item.result = output;
                    item.isError = message.isError;
                    item.running = false;
                    applySubagentPresentation(item, message.details, {});
                    applyWorkflowPresentation(item, message.details, workflows);
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
        const item = buildToolDisplayItem(
            `tool-execution:${execution.id}`,
            execution.id,
            execution.name,
            execution.args,
            execution,
            workflows,
        );
        result.push(item);
    }

    return result;
}

function sameDisplayPresentation(left: DisplayItem, right: DisplayItem): boolean {
    if (left.kind !== right.kind || left.id !== right.id) return false;
    switch (left.kind) {
        case "user":
            return right.kind === "user" && left.text === right.text;
        case "assistant":
            return right.kind === "assistant" && left.text === right.text && left.streaming === right.streaming;
        case "thinking":
            return right.kind === "thinking" && left.text === right.text && left.streaming === right.streaming;
        case "custom":
        case "summary":
            return right.kind === left.kind && left.text === right.text && left.label === right.label;
        case "tool":
            return (
                right.kind === "tool" &&
                left.toolCallId === right.toolCallId &&
                left.name === right.name &&
                left.title === right.title &&
                left.args === right.args &&
                left.result === right.result &&
                left.isError === right.isError &&
                left.running === right.running &&
                left.subagentKey === right.subagentKey &&
                left.workflowRunId === right.workflowRunId &&
                left.workflowKey === right.workflowKey
            );
        case "bash":
            return (
                right.kind === "bash" &&
                left.command === right.command &&
                left.output === right.output &&
                left.exitCode === right.exitCode &&
                left.cancelled === right.cancelled &&
                left.excluded === right.excluded &&
                left.running === right.running
            );
    }
}

/** Reuse prior display identities when their bounded presentation is unchanged. */
export function reconcileDisplayItems(previous: DisplayItem[], next: DisplayItem[]): DisplayItem[] {
    const previousById = new Map(previous.map((item) => [item.id, item]));
    const reconciled = next.map((item) => {
        const prior = previousById.get(item.id);
        return prior && sameDisplayPresentation(prior, item) ? prior : item;
    });
    return reconciled.length === previous.length && reconciled.every((item, index) => item === previous[index])
        ? previous
        : reconciled;
}
