import type { Model } from "@earendil-works/pi-ai";
import type { SubagentViewModel } from "./subagent.js";

export type DisplayItem =
  | {
      id: string;
      kind: "user" | "assistant" | "thinking" | "custom" | "summary";
      text: string;
      label?: string;
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      name: string;
      title: string;
      args: string;
      result?: string;
      isError?: boolean;
      running?: boolean;
      partialDetails?: unknown;
      resultDetails?: unknown;
      subagent?: SubagentViewModel;
      subagentKey?: string;
    }
  | {
      id: string;
      kind: "bash";
      command: string;
      output: string;
      exitCode?: number;
      cancelled: boolean;
      excluded: boolean;
      running?: boolean;
    };

export interface ActiveTool {
  id: string;
  name: string;
  title: string;
  detail: string;
  startedAt: number;
}

export interface ToastMessage {
  id: number;
  message: string;
  type: "info" | "warning" | "error" | "success";
}

export interface PuiSnapshot {
  revision: number;
  cwd: string;
  compactCwd: string;
  gitBranch?: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  modelId: string;
  modelProvider?: string;
  thinkingLevel: string;
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  workingMessage?: string;
  queuedSteering: readonly string[];
  queuedFollowUp: readonly string[];
  display: DisplayItem[];
  activeTools: ActiveTool[];
  activeToolNames: string[];
  toasts: ToastMessage[];
  exitRequested: boolean;
}

export interface ModelChoice {
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

export type PromptAction = "sent" | "models" | "sessions" | "commands" | "help" | "ignored";
