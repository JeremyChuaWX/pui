import type { Model } from "@earendil-works/pi-ai";
import type { BackgroundSubagentViewModel } from "./background-subagent.js";
import type { SubagentViewModel } from "./subagent.js";
import type { WorkflowRunSummaryV1 } from "./workflow.js";

interface DisplayItemBase {
    id: string;
}

interface UserDisplayItem extends DisplayItemBase {
    kind: "user";
    text: string;
}

interface AssistantDisplayItem extends DisplayItemBase {
    kind: "assistant";
    text: string;
    streaming?: boolean;
}

interface ThinkingDisplayItem extends DisplayItemBase {
    kind: "thinking";
    text: string;
    streaming?: boolean;
}

interface CustomDisplayItem extends DisplayItemBase {
    kind: "custom";
    text: string;
    label?: string;
}

interface SummaryDisplayItem extends DisplayItemBase {
    kind: "summary";
    text: string;
    label?: string;
}

export interface ToolDisplayItem extends DisplayItemBase {
    kind: "tool";
    toolCallId: string;
    name: string;
    title: string;
    args: string;
    result?: string;
    isError?: boolean;
    running?: boolean;
    subagent?: SubagentViewModel;
    subagentKey?: string;
}

interface BashDisplayItem extends DisplayItemBase {
    kind: "bash";
    command: string;
    output: string;
    exitCode?: number;
    cancelled: boolean;
    excluded: boolean;
    running?: boolean;
}

export type DisplayItem =
    | UserDisplayItem
    | AssistantDisplayItem
    | ThinkingDisplayItem
    | CustomDisplayItem
    | SummaryDisplayItem
    | ToolDisplayItem
    | BashDisplayItem;

export interface ActiveTool {
    id: string;
    title: string;
}

export interface ToastMessage {
    id: number;
    message: string;
    type: "info" | "warning" | "error" | "success";
}

export interface PuiSnapshot {
    cwd: string;
    compactCwd: string;
    gitBranch?: string;
    sessionId: string;
    sessionName?: string;
    modelId: string;
    modelProvider?: string;
    thinkingLevel: string;
    contextTokens?: number | null;
    contextWindow?: number;
    contextPercent?: number | null;
    isStreaming: boolean;
    isCompacting: boolean;
    queuedSteering: readonly string[];
    queuedFollowUp: readonly string[];
    display: DisplayItem[];
    activeTools: ActiveTool[];
    backgroundSubagents: BackgroundSubagentViewModel[];
    workflows: readonly WorkflowRunSummaryV1[];
    toasts: ToastMessage[];
    exitRequested: boolean;
}

export interface ModelChoice {
    // biome-ignore lint/suspicious/noExplicitAny: Pi models use provider-specific API payloads.
    model: Model<any>;
    label: string;
    detail: string;
    search: string;
}

export interface SessionChoice {
    path: string;
    label: string;
    detail: string;
    search: string;
}

export interface PromptCompletionItem {
    value: string;
    label: string;
    description?: string;
}

export interface PromptCompletions {
    items: PromptCompletionItem[];
    prefix: string;
}

export interface AppliedPromptCompletion {
    text: string;
    cursorOffset: number;
}

export type PromptAction = "sent" | "models" | "sessions" | "subagents" | "commands" | "help" | "ignored";
