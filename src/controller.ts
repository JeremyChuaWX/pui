import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { buildDisplayItems, formatCount, formatToolTitle } from "./format.js";
import { textOffset, textPosition } from "./prompt-autocomplete.js";
import type {
  ActiveTool,
  AppliedPromptCompletion,
  DisplayItem,
  ModelChoice,
  PiTuiSnapshot,
  PromptAction,
  PromptCompletionItem,
  PromptCompletions,
  SessionChoice,
  ToastMessage,
} from "./types.js";

export interface ControllerOptions {
  cwd: string;
  continueRecent?: boolean;
  sessionPath?: string;
  noSession?: boolean;
}

type Listener = (snapshot: PiTuiSnapshot) => void;

const COALESCED_SESSION_EVENTS = new Set<AgentSessionEvent["type"]>([
  "queue_update",
  "message_start",
  "message_update",
  "message_end",
  "entry_appended",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_execution_update",
]);

const LOCAL_SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Select the active model", argumentHint: "<provider/model>" },
  { name: "resume", description: "Resume a previous session" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact conversation context" },
  { name: "name", description: "Set the session name", argumentHint: "<name>" },
  { name: "reload", description: "Reload extensions, skills, prompts, and context" },
  { name: "session", description: "Show session information" },
  { name: "commands", description: "Open the command palette" },
  { name: "thinking", description: "Cycle the thinking level" },
  { name: "help", description: "Show keyboard shortcuts" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "quit", description: "Quit" },
];

function sameDisplayItem(left: DisplayItem, right: DisplayItem): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.is(leftRecord[key], rightRecord[key]));
}

function findExecutable(name: string): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

interface RunningBash {
  command: string;
  output: string;
  excluded: boolean;
}

function compactPath(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}${path.sep}`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function readGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export class PiTuiController {
  private runtime: AgentSessionRuntime;
  private unsubscribeSession?: () => void;
  private listeners = new Set<Listener>();
  private activeTools = new Map<string, ActiveTool>();
  private autocompleteProvider?: CombinedAutocompleteProvider;
  private displayItems: DisplayItem[] = [];
  private runningBash?: RunningBash;
  private workingMessage?: string;
  private toasts: ToastMessage[] = [];
  private toastId = 0;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private revision = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private exitRequested = false;
  private gitBranch?: string;
  private currentSnapshot: PiTuiSnapshot;

  private constructor(runtime: AgentSessionRuntime) {
    this.runtime = runtime;
    this.gitBranch = readGitBranch(runtime.cwd);
    this.currentSnapshot = this.buildSnapshot();
  }

  static async create(options: ControllerOptions): Promise<PiTuiController> {
    const agentDir = getAgentDir();
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir: targetAgentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd, agentDir: targetAgentDir });
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    let sessionManager: SessionManager;
    if (options.noSession) {
      sessionManager = SessionManager.inMemory(options.cwd);
    } else if (options.sessionPath) {
      sessionManager = SessionManager.open(path.resolve(options.sessionPath));
    } else if (options.continueRecent) {
      sessionManager = SessionManager.continueRecent(options.cwd);
    } else {
      sessionManager = SessionManager.create(options.cwd);
    }

    const sessionCwd = options.sessionPath ? sessionManager.getCwd() || options.cwd : options.cwd;
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionCwd,
      agentDir,
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const controller = new PiTuiController(runtime);

    runtime.setRebindSession(async (session) => controller.bindSession(session));
    await controller.bindSession(runtime.session);

    for (const diagnostic of runtime.diagnostics) {
      controller.notify(diagnostic.message, diagnostic.type === "error" ? "error" : diagnostic.type);
    }
    if (runtime.modelFallbackMessage) controller.notify(runtime.modelFallbackMessage, "warning");

    return controller;
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  snapshot(): PiTuiSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribeSession?.();
    this.activeTools.clear();
    this.displayItems = [];
    this.runningBash = undefined;
    this.workingMessage = undefined;
    this.gitBranch = readGitBranch(this.runtime.cwd);

    await session.bindExtensions({
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => this.runtime.session.waitForIdle(),
        newSession: (options) => this.runtime.newSession(options),
        fork: (entryId, options) => this.runtime.fork(entryId, options),
        navigateTree: (targetId, options) => this.runtime.session.navigateTree(targetId, options),
        switchSession: (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
        reload: async () => {
          await this.runtime.session.reload();
        },
      },
      abortHandler: () => {
        void this.abort();
      },
      shutdownHandler: () => {
        void session.waitForIdle().then(() => {
          if (this.runtime.session === session) this.requestExit();
        });
      },
      onError: (error) => this.notify(`${path.basename(error.extensionPath)}: ${error.error}`, "error"),
    });

    this.setupAutocompleteProvider();
    this.unsubscribeSession = session.subscribe((event) => this.handleEvent(event));
    this.refresh();
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start": {
        this.activeTools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          title: formatToolTitle(event.toolName, event.args ?? {}),
          detail: event.args ? JSON.stringify(event.args) : "",
          startedAt: Date.now(),
        });
        this.workingMessage = `Running ${event.toolName}`;
        break;
      }
      case "tool_execution_end":
        this.activeTools.delete(event.toolCallId);
        this.workingMessage = undefined;
        break;
      case "compaction_start":
        this.workingMessage = "Compacting context";
        break;
      case "compaction_end":
        this.workingMessage = event.errorMessage ? `Compaction failed: ${event.errorMessage}` : undefined;
        break;
      case "auto_retry_start":
        this.workingMessage = `Retry ${event.attempt}/${event.maxAttempts}`;
        break;
      case "auto_retry_end":
        this.workingMessage = event.success ? undefined : event.finalError;
        break;
      case "agent_start":
        this.workingMessage ??= "Thinking";
        break;
      case "agent_settled":
        this.workingMessage = undefined;
        this.activeTools.clear();
        break;
      case "session_info_changed":
      case "thinking_level_changed":
      case "queue_update":
      case "message_start":
      case "message_update":
      case "message_end":
      case "entry_appended":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "tool_execution_update":
        break;
    }
    if (COALESCED_SESSION_EVENTS.has(event.type)) {
      this.scheduleRefresh();
      return;
    }
    this.refresh();
  }

  private reconcileDisplayItems(nextItems: DisplayItem[]): DisplayItem[] {
    const previousById = new Map(this.displayItems.map((item) => [item.id, item]));
    const reconciled = nextItems.map((item) => {
      const previous = previousById.get(item.id);
      return previous && sameDisplayItem(previous, item) ? previous : item;
    });
    if (
      reconciled.length === this.displayItems.length &&
      reconciled.every((item, index) => item === this.displayItems[index])
    ) {
      return this.displayItems;
    }
    this.displayItems = reconciled;
    return reconciled;
  }

  private buildSnapshot(): PiTuiSnapshot {
    const session = this.runtime.session;
    const context = session.getContextUsage();
    const streamingMessage = session.agent.state.streamingMessage as AgentMessage | undefined;
    const display = buildDisplayItems(session.messages, streamingMessage);

    if (this.runningBash) {
      display.push({
        id: "running-bash",
        kind: "bash",
        command: this.runningBash.command,
        output: this.runningBash.output,
        cancelled: false,
        excluded: this.runningBash.excluded,
        running: true,
      });
    }

    const stableDisplay = this.reconcileDisplayItems(display);

    return {
      revision: this.revision,
      cwd: this.runtime.cwd,
      compactCwd: compactPath(this.runtime.cwd),
      gitBranch: this.gitBranch,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      modelId: session.model?.id ?? "no model",
      modelProvider: session.model?.provider,
      thinkingLevel: session.thinkingLevel,
      contextTokens: context?.tokens,
      contextWindow: context?.contextWindow,
      contextPercent: context?.percent,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isRetrying: session.isRetrying,
      workingMessage: this.workingMessage,
      queuedSteering: [...session.getSteeringMessages()],
      queuedFollowUp: [...session.getFollowUpMessages()],
      display: stableDisplay,
      activeTools: [...this.activeTools.values()],
      activeToolNames: session.getActiveToolNames(),
      toasts: [...this.toasts],
      exitRequested: this.exitRequested,
    };
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 16);
  }

  private refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.disposed) return;
    this.revision += 1;
    this.currentSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.currentSnapshot);
  }

  notify(message: string, type: ToastMessage["type"] = "info"): void {
    const toast = { id: ++this.toastId, message, type };
    this.toasts = [...this.toasts.slice(-2), toast];
    this.refresh();

    const timer = setTimeout(() => {
      this.toastTimers.delete(timer);
      this.toasts = this.toasts.filter((candidate) => candidate.id !== toast.id);
      this.refresh();
    }, 5_000);
    this.toastTimers.add(timer);
  }

  private setupAutocompleteProvider(): void {
    const localCommands = LOCAL_SLASH_COMMANDS.map((command) => ({ ...command }));
    const modelCommand = localCommands.find((command) => command.name === "model");
    if (modelCommand) {
      modelCommand.getArgumentCompletions = async (prefix) => {
        const terms = prefix.toLowerCase().split(/[^a-z0-9._-]+/).filter(Boolean);
        const choices = await this.listModels();
        return choices
          .filter((choice) => terms.every((term) => choice.search.includes(term)))
          .slice(0, 20)
          .map((choice) => ({
            value: `${choice.model.provider}/${choice.model.id}`,
            label: choice.model.id,
            description: choice.model.provider,
          }));
      };
    }

    const localNames = new Set(localCommands.map((command) => command.name));
    const extensionCommands: SlashCommand[] = this.session.extensionRunner
      .getRegisteredCommands()
      .filter((command) => !localNames.has(command.invocationName))
      .map((command) => ({
        name: command.invocationName,
        description: command.description ? `[extension] ${command.description}` : "[extension]",
        getArgumentCompletions: command.getArgumentCompletions,
      }));
    const templateCommands: SlashCommand[] = this.session.promptTemplates
      .filter((template) => !localNames.has(template.name))
      .map((template) => ({
        name: template.name,
        description: template.description ? `[prompt] ${template.description}` : "[prompt]",
        ...(template.argumentHint && { argumentHint: template.argumentHint }),
      }));
    const skillCommands: SlashCommand[] = this.session.settingsManager.getEnableSkillCommands()
      ? this.session.resourceLoader.getSkills().skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: `[skill] ${skill.description}`,
        }))
      : [];

    this.autocompleteProvider = new CombinedAutocompleteProvider(
      [...localCommands, ...extensionCommands, ...templateCommands, ...skillCommands],
      this.runtime.cwd,
      findExecutable("fd") ?? findExecutable("fdfind") ?? null,
    );
  }

  async getPromptCompletions(
    text: string,
    cursorOffset: number,
    signal: AbortSignal,
  ): Promise<PromptCompletions | undefined> {
    const provider = this.autocompleteProvider;
    if (!provider || signal.aborted) return undefined;
    const { lines, line, column } = textPosition(text, cursorOffset);
    const suggestions = await provider.getSuggestions(lines, line, column, { signal });
    if (!suggestions || signal.aborted) return undefined;
    return {
      prefix: suggestions.prefix,
      items: suggestions.items.map((item) => ({
        value: item.value,
        label: item.label,
        description: item.description,
      })),
    };
  }

  applyPromptCompletion(
    text: string,
    cursorOffset: number,
    item: PromptCompletionItem,
    prefix: string,
  ): AppliedPromptCompletion | undefined {
    const provider = this.autocompleteProvider;
    if (!provider) return undefined;
    const { lines, line, column } = textPosition(text, cursorOffset);
    const applied = provider.applyCompletion(lines, line, column, item as AutocompleteItem, prefix);
    return {
      text: applied.lines.join("\n"),
      cursorOffset: textOffset(applied.lines, applied.cursorLine, applied.cursorCol),
    };
  }

  handlePrompt(text: string, delivery: "steer" | "followUp" = "steer"): PromptAction {
    const trimmed = text.trim();
    if (!trimmed) return "ignored";

    const [firstLine = "", ...rest] = trimmed.split("\n");
    const [command = "", ...firstArgs] = firstLine.split(/\s+/);
    const args = [...firstArgs, ...rest].join(" ").trim();

    switch (command) {
      case "/model":
      case "/models":
        if (args) {
          void this.selectModelBySpec(args);
          return "sent";
        }
        return "models";
      case "/resume":
      case "/sessions":
        return "sessions";
      case "/commands":
      case "/palette":
        return "commands";
      case "/help":
      case "/hotkeys":
        return "help";
      case "/new":
      case "/clear":
        void this.newSession();
        return "sent";
      case "/compact":
        void this.compact(args || undefined);
        return "sent";
      case "/name":
        if (!args) this.notify("Usage: /name <session name>", "warning");
        else this.session.setSessionName(args);
        return "sent";
      case "/reload":
        void this.reload();
        return "sent";
      case "/thinking":
        this.cycleThinking();
        return "sent";
      case "/session":
        this.notify(
          `${this.session.sessionName ?? this.session.sessionId.slice(0, 8)} · ${formatCount(this.session.getContextUsage()?.tokens)} context tokens`,
        );
        return "sent";
      case "/quit":
      case "/exit":
      case "/q":
        this.requestExit();
        return "sent";
    }

    if (trimmed.startsWith("!")) {
      const excluded = trimmed.startsWith("!!");
      const shellCommand = trimmed.slice(excluded ? 2 : 1).trim();
      if (shellCommand) void this.executeBash(shellCommand, excluded);
      return "sent";
    }

    const wasStreaming = this.session.isStreaming;
    void this.session
      .prompt(text, {
        source: "interactive",
        streamingBehavior: wasStreaming ? delivery : undefined,
        preflightResult: (accepted) => {
          if (!accepted) this.notify("Prompt was not accepted", "warning");
        },
      })
      .catch((error: unknown) => this.notify(error instanceof Error ? error.message : String(error), "error"));
    return "sent";
  }

  private async executeBash(command: string, excluded: boolean): Promise<void> {
    if (this.session.isBashRunning) {
      this.notify("A shell command is already running", "warning");
      return;
    }
    this.runningBash = { command, output: "", excluded };
    this.workingMessage = "Running shell command";
    this.refresh();
    try {
      await this.session.executeBash(
        command,
        (chunk) => {
          if (!this.runningBash) return;
          this.runningBash.output += chunk;
          this.scheduleRefresh();
        },
        { excludeFromContext: excluded },
      );
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.runningBash = undefined;
      this.workingMessage = undefined;
      this.refresh();
    }
  }

  async listModels(): Promise<ModelChoice[]> {
    const models = await this.runtime.services.modelRuntime.getAvailable();
    const current = this.session.model;
    return [...models]
      .sort((a, b) => {
        if (a.provider === current?.provider && a.id === current.id) return -1;
        if (b.provider === current?.provider && b.id === current.id) return 1;
        return `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`);
      })
      .map((model) => ({
        model,
        label: model.name || model.id,
        detail: `${model.provider}/${model.id}${model.reasoning ? " · reasoning" : ""}`,
        search: `${model.provider} ${model.id} ${model.name}`.toLowerCase(),
      }));
  }

  async selectModelBySpec(spec: string): Promise<void> {
    const value = spec.trim().split(/\s+/, 1)[0] ?? "";
    const slash = value.indexOf("/");
    if (slash <= 0) {
      this.notify("Use /model provider/model", "warning");
      return;
    }
    const provider = value.slice(0, slash);
    const modelId = value.slice(slash + 1);
    const model = this.runtime.services.modelRuntime.getModel(provider, modelId);
    if (!model) {
      this.notify(`Unknown model: ${value}`, "error");
      return;
    }
    await this.selectModel({
      model,
      label: model.name || model.id,
      detail: `${model.provider}/${model.id}`,
      search: `${model.provider} ${model.id} ${model.name}`.toLowerCase(),
    });
  }

  async selectModel(choice: ModelChoice): Promise<void> {
    try {
      await this.session.setModel(choice.model);
      this.notify(`Model: ${choice.model.name || choice.model.id}`, "success");
      this.refresh();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async listSessions(): Promise<SessionChoice[]> {
    const sessions = await SessionManager.list(this.runtime.cwd);
    return sessions
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .map((session) => {
        const fallback = session.firstMessage.replace(/\s+/g, " ").trim() || session.id.slice(0, 8);
        const label = session.name || (fallback.length > 70 ? `${fallback.slice(0, 67)}…` : fallback);
        const detail = `${session.modified.toLocaleString()} · ${session.messageCount} messages`;
        return {
          path: session.path,
          label,
          detail,
          search: `${label} ${session.cwd} ${session.id}`.toLowerCase(),
        };
      });
  }

  async switchSession(sessionPath: string): Promise<void> {
    try {
      const result = await this.runtime.switchSession(sessionPath);
      if (!result.cancelled) this.notify("Session resumed", "success");
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async newSession(): Promise<void> {
    try {
      const result = await this.runtime.newSession();
      if (!result.cancelled) this.notify("New session", "success");
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async compact(instructions?: string): Promise<void> {
    try {
      await this.session.compact(instructions);
      this.notify("Context compacted", "success");
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async reload(): Promise<void> {
    try {
      await this.session.reload();
      this.setupAutocompleteProvider();
      this.notify("Pi resources reloaded", "success");
      this.refresh();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async cycleModel(direction: "forward" | "backward"): Promise<void> {
    try {
      const result = await this.session.cycleModel(direction);
      if (result) this.notify(`Model: ${result.model.name || result.model.id}`, "success");
      this.refresh();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  cycleThinking(): void {
    const level = this.session.cycleThinkingLevel();
    if (level) this.notify(`Thinking: ${level}`);
    else this.notify("This model does not support thinking", "warning");
    this.refresh();
  }

  async abort(): Promise<void> {
    if (this.session.isCompacting) this.session.abortCompaction();
    if (this.session.isBashRunning) this.session.abortBash();
    try {
      await this.session.abort();
    } finally {
      this.activeTools.clear();
      this.runningBash = undefined;
      this.workingMessage = undefined;
      this.refresh();
    }
  }

  requestExit(): void {
    this.exitRequested = true;
    this.refresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSession?.();
    this.runtime.setRebindSession(undefined);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const timer of this.toastTimers) clearTimeout(timer);
    this.toastTimers.clear();
    await this.runtime.dispose();
    this.listeners.clear();
  }
}
