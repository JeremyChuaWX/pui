import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    type AgentSession,
    type AgentSessionEvent,
    type AgentSessionRuntime,
    type CreateAgentSessionRuntimeFactory,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createEventBus,
    type EventBusController,
    getAgentDir,
    type InlineExtension,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { resolveFdBinary } from "../extensions/file-search/binaries.js";
import { errorMessage } from "../extensions/shared/validate.js";
import { BackgroundSubagentBridge } from "./background-subagent.js";
import { BUNDLED_EXTENSION_FACTORIES } from "./bundled-extensions.js";
import { ExtensionDialogQueue, ToastQueue } from "./controller-queues.js";
import { buildDisplayItems, formatCount, formatToolTitle, reconcileDisplayItems } from "./format.js";
import { textOffset, textPosition } from "./prompt-autocomplete.js";
import {
    reconcileToolExecutions,
    reduceToolExecutions,
    runningToolExecutions,
    type ToolExecutionState,
} from "./tool-executions.js";
import type {
    ActiveTool,
    AppliedPromptCompletion,
    DisplayItem,
    ModelChoice,
    PromptAction,
    PromptCompletionItem,
    PromptCompletions,
    PuiSnapshot,
    SessionChoice,
    ToastMessage,
} from "./types.js";
import { WorkflowBridge, type WorkflowControlAction, type WorkflowRunSummaryV1 } from "./workflow-bridge.js";

export interface ControllerOptions {
    cwd: string;
    continueRecent?: boolean;
    sessionPath?: string;
    noSession?: boolean;
}

/** Injectable collaborators; every field has a production default. */
export interface ControllerDependencies {
    eventBus?: EventBusController;
    extensionFactories?: InlineExtension[];
    readGitBranch?: (cwd: string) => string | undefined;
}

export function createPuiRuntimeFactory(
    eventBus: EventBusController,
    extensionFactories: InlineExtension[] = BUNDLED_EXTENSION_FACTORIES,
): CreateAgentSessionRuntimeFactory {
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            resourceLoaderOptions: {
                extensionFactories,
                eventBus,
            },
        });
        return {
            ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
            services,
            diagnostics: services.diagnostics,
        };
    };
}

type Listener = (snapshot: PuiSnapshot) => void;

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

interface RunningBash {
    command: string;
    output: string;
    excluded: boolean;
}

/** One entry drives autocomplete, dispatch, and the command's behavior. */
interface LocalCommand {
    name: string;
    description: string;
    argumentHint?: string;
    /** Dispatch-only aliases, hidden from autocomplete. */
    aliases?: readonly string[];
    /** Dispatchable but omitted from autocomplete (e.g. shadowed extension commands). */
    hidden?: boolean;
    run: (controller: PuiController, args: string) => PromptAction;
}

const LOCAL_COMMANDS: readonly LocalCommand[] = [
    {
        name: "model",
        description: "Select the active model",
        argumentHint: "<provider/model>",
        aliases: ["models"],
        run: (controller, args) => {
            if (!args) return "models";
            void controller.selectModelBySpec(args);
            return "sent";
        },
    },
    { name: "resume", description: "Resume a previous session", aliases: ["sessions"], run: () => "sessions" },
    {
        name: "new",
        description: "Start a new session",
        aliases: ["clear"],
        run: (controller) => {
            void controller.newSession();
            return "sent";
        },
    },
    {
        name: "compact",
        description: "Compact conversation context",
        run: (controller, args) => {
            void controller.compact(args || undefined);
            return "sent";
        },
    },
    {
        name: "name",
        description: "Set the session name",
        argumentHint: "<name>",
        run: (controller, args) => {
            if (!args) controller.notify("Usage: /name <session name>", "warning");
            else controller.session.setSessionName(args);
            return "sent";
        },
    },
    {
        name: "reload",
        description: "Reload extensions, skills, prompts, and context",
        run: (controller) => {
            void controller.reload();
            return "sent";
        },
    },
    {
        name: "session",
        description: "Show session information",
        run: (controller) => {
            const session = controller.session;
            controller.notify(
                `${session.sessionName ?? session.sessionId.slice(0, 8)} · ${formatCount(session.getContextUsage()?.tokens)} context tokens`,
            );
            return "sent";
        },
    },
    { name: "commands", description: "Open the command palette", aliases: ["palette"], run: () => "commands" },
    { name: "subagents", description: "Inspect or cancel background subagents", run: () => "subagents" },
    { name: "workflows", description: "Inspect and control workflow runs", hidden: true, run: () => "workflows" },
    {
        name: "thinking",
        description: "Cycle the thinking level",
        run: (controller) => {
            controller.cycleThinking();
            return "sent";
        },
    },
    { name: "help", description: "Show keyboard shortcuts", run: () => "help" },
    { name: "hotkeys", description: "Show keyboard shortcuts", run: () => "help" },
    {
        name: "quit",
        description: "Quit",
        aliases: ["exit", "q"],
        run: (controller) => {
            controller.requestExit();
            return "sent";
        },
    },
];

function findLocalCommand(name: string): LocalCommand | undefined {
    return LOCAL_COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}

function compactPath(cwd: string): string {
    const home = os.homedir();
    if (cwd === home) return "~";
    if (cwd.startsWith(`${home}${path.sep}`)) return `~${cwd.slice(home.length)}`;
    return cwd;
}

function canonicalPath(cwd: string): string {
    try {
        return fs.realpathSync.native(cwd);
    } catch {
        return path.resolve(cwd);
    }
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

export class PuiController {
    private runtime: AgentSessionRuntime;
    private unsubscribeSession?: () => void;
    private listeners = new Set<Listener>();
    private toolExecutions: ToolExecutionState = new Map();
    private autocompleteProvider?: CombinedAutocompleteProvider;
    private displayItems: DisplayItem[] = [];
    private runningBash?: RunningBash;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private bindGeneration = 0;
    private exitRequested = false;
    private gitBranch?: string;
    private currentSnapshot: PuiSnapshot;
    private readonly readGitBranch: (cwd: string) => string | undefined;
    private readonly toasts = new ToastQueue(() => this.refresh());
    private readonly extensionDialogs = new ExtensionDialogQueue(() => this.refresh());
    private readonly workflows: WorkflowBridge;
    private readonly backgroundSubagents: BackgroundSubagentBridge;
    private readonly eventBus: EventBusController;

    constructor(runtime: AgentSessionRuntime, dependencies: ControllerDependencies = {}) {
        this.runtime = runtime;
        this.eventBus = dependencies.eventBus ?? createEventBus();
        this.readGitBranch = dependencies.readGitBranch ?? readGitBranch;
        this.workflows = new WorkflowBridge({ eventBus: this.eventBus, onChange: () => this.scheduleRefresh() });
        this.backgroundSubagents = new BackgroundSubagentBridge({
            eventBus: this.eventBus,
            onChange: () => this.scheduleRefresh(),
        });
        this.backgroundSubagents.bind(runtime.session.sessionId);
        this.gitBranch = this.readGitBranch(runtime.cwd);
        this.currentSnapshot = this.buildSnapshot();
    }

    static async create(options: ControllerOptions, dependencies: ControllerDependencies = {}): Promise<PuiController> {
        const agentDir = getAgentDir();
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
        const eventBus = dependencies.eventBus ?? createEventBus();
        const runtime = await createAgentSessionRuntime(
            createPuiRuntimeFactory(eventBus, dependencies.extensionFactories),
            {
                cwd: sessionCwd,
                agentDir,
                sessionManager,
                sessionStartEvent: { type: "session_start", reason: "startup" },
            },
        );
        const controller = new PuiController(runtime, { ...dependencies, eventBus });

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

    snapshot(): PuiSnapshot {
        return this.currentSnapshot;
    }

    getLastAssistantText(): string {
        const messages = this.session.messages;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message?.role !== "assistant") continue;
            const text = message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
                .trimEnd();
            if (text.trim()) return text;
        }
        return "";
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        listener(this.currentSnapshot);
        return () => this.listeners.delete(listener);
    }

    /** Attach to a session; invoked at startup and whenever the runtime rebinds. */
    async bindSession(session: AgentSession): Promise<void> {
        const generation = ++this.bindGeneration;
        this.extensionDialogs.dismissAll();
        this.backgroundSubagents.bind(session.sessionId);
        this.workflows.bind(session.sessionId, canonicalPath(this.runtime.cwd));
        this.unsubscribeSession?.();
        this.toolExecutions = new Map();
        this.displayItems = [];
        this.runningBash = undefined;
        this.gitBranch = this.readGitBranch(this.runtime.cwd);

        const existingUI = session.extensionRunner.getUIContext?.() ?? {};
        await session.bindExtensions({
            mode: "tui",
            uiContext: {
                ...existingUI,
                confirm: (title, message, options) =>
                    this.extensionDialogs.request({ kind: "confirm", title, message }, options).then(Boolean),
                select: (title, options, dialogOptions) =>
                    this.extensionDialogs.request({ kind: "select", title, options }, dialogOptions) as Promise<
                        string | undefined
                    >,
                input: (title, placeholder, options) =>
                    this.extensionDialogs.request({ kind: "input", title, placeholder }, options) as Promise<
                        string | undefined
                    >,
                notify: (message, type) => this.notify(message, type),
            },
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

        if (this.disposed || generation !== this.bindGeneration || this.runtime.session !== session) return;
        this.setupAutocompleteProvider();
        this.unsubscribeSession = session.subscribe((event) => this.handleEvent(event));
        this.refresh();
    }

    private handleEvent(event: AgentSessionEvent): void {
        switch (event.type) {
            case "tool_execution_start":
            case "tool_execution_update":
            case "tool_execution_end":
                this.toolExecutions = reduceToolExecutions(this.toolExecutions, event);
                break;
            case "agent_settled":
                this.toolExecutions = this.reconcileToolExecutionState(true);
                break;
            default:
                break;
        }
        if (COALESCED_SESSION_EVENTS.has(event.type)) {
            this.scheduleRefresh();
            return;
        }
        this.refresh();
    }

    private persistedToolCallIds(): Set<string> {
        return new Set(
            this.runtime.session.messages
                .filter((message) => message.role === "toolResult")
                .map((message) => message.toolCallId),
        );
    }

    private reconcileToolExecutionState(settled = false): ToolExecutionState {
        return reconcileToolExecutions(this.toolExecutions, {
            pendingToolCallIds: this.runtime.session.agent.state.pendingToolCalls,
            persistedToolCallIds: this.persistedToolCallIds(),
            settled,
        });
    }

    private buildSnapshot(): PuiSnapshot {
        const session = this.runtime.session;
        const context = session.getContextUsage();
        const streamingMessage = session.agent.state.streamingMessage as AgentMessage | undefined;
        this.toolExecutions = this.reconcileToolExecutionState();
        const workflows = this.workflows.runs();
        const display = buildDisplayItems(session.messages, streamingMessage, {
            toolExecutions: this.toolExecutions,
            workflows,
        });

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

        const stableDisplay = reconcileDisplayItems(this.displayItems, display);
        this.displayItems = stableDisplay;
        const runningExecutions = runningToolExecutions(this.toolExecutions);
        const activeTools: ActiveTool[] = runningExecutions.map((execution) => ({
            id: execution.id,
            title: formatToolTitle(execution.name, execution.args),
        }));
        return {
            cwd: this.runtime.cwd,
            compactCwd: compactPath(this.runtime.cwd),
            gitBranch: this.gitBranch,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            modelId: session.model?.id ?? "no model",
            modelProvider: session.model?.provider,
            thinkingLevel: session.thinkingLevel,
            contextTokens: context?.tokens,
            contextWindow: context?.contextWindow,
            contextPercent: context?.percent,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            queuedSteering: [...session.getSteeringMessages()],
            queuedFollowUp: [...session.getFollowUpMessages()],
            display: stableDisplay,
            activeTools,
            backgroundSubagents: this.backgroundSubagents.jobs(),
            workflows,
            extensionDialog: this.extensionDialogs.current(),
            toasts: this.toasts.list(),
            exitRequested: this.exitRequested,
        };
    }

    resolveExtensionDialog(id: number, value: boolean | string | undefined): boolean {
        return this.extensionDialogs.resolve(id, value);
    }

    private scheduleRefresh(): void {
        if (this.disposed || this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
        }, 16);
    }

    /** Rebuild the snapshot immediately and notify subscribers. */
    refresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        if (this.disposed) return;
        this.currentSnapshot = this.buildSnapshot();
        for (const listener of this.listeners) listener(this.currentSnapshot);
    }

    notify(message: string, type: ToastMessage["type"] = "info"): void {
        this.toasts.push(message, type);
    }

    private setupAutocompleteProvider(): void {
        const localCommands: SlashCommand[] = LOCAL_COMMANDS.filter((command) => !command.hidden).map((command) => ({
            name: command.name,
            description: command.description,
            ...(command.argumentHint && { argumentHint: command.argumentHint }),
        }));
        const modelCommand = localCommands.find((command) => command.name === "model");
        if (modelCommand) {
            modelCommand.getArgumentCompletions = async (prefix) => {
                const terms = prefix
                    .toLowerCase()
                    .split(/[^a-z0-9._-]+/)
                    .filter(Boolean);
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
            (() => {
                try {
                    return resolveFdBinary().command;
                } catch {
                    return undefined;
                }
            })(),
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

        if (command.startsWith("/")) {
            const local = findLocalCommand(command.slice(1));
            if (local) return local.run(this, args);
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
            .catch((error: unknown) => this.notify(errorMessage(error), "error"));
        return command === "/workflow" && args ? "workflow" : "sent";
    }

    private async executeBash(command: string, excluded: boolean): Promise<void> {
        if (this.session.isBashRunning) {
            this.notify("A shell command is already running", "warning");
            return;
        }
        this.runningBash = { command, output: "", excluded };
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
            this.notify(errorMessage(error), "error");
        } finally {
            this.runningBash = undefined;
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
            this.notify(errorMessage(error), "error");
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
            this.notify(errorMessage(error), "error");
        }
    }

    async newSession(): Promise<void> {
        try {
            const result = await this.runtime.newSession();
            if (!result.cancelled) this.notify("New session", "success");
        } catch (error) {
            this.notify(errorMessage(error), "error");
        }
    }

    async compact(instructions?: string): Promise<void> {
        try {
            await this.session.compact(instructions);
            this.notify("Context compacted", "success");
        } catch (error) {
            this.notify(errorMessage(error), "error");
        }
    }

    async reload(): Promise<void> {
        try {
            await this.session.reload();
            this.setupAutocompleteProvider();
            this.notify("Pi resources reloaded", "success");
            this.refresh();
        } catch (error) {
            this.notify(errorMessage(error), "error");
        }
    }

    async cycleModel(direction: "forward" | "backward"): Promise<void> {
        try {
            const result = await this.session.cycleModel(direction);
            if (result) this.notify(`Model: ${result.model.name || result.model.id}`, "success");
            this.refresh();
        } catch (error) {
            this.notify(errorMessage(error), "error");
        }
    }

    cycleThinking(): void {
        const level = this.session.cycleThinkingLevel();
        if (level) this.notify(`Thinking: ${level}`);
        else this.notify("This model does not support thinking", "warning");
        this.refresh();
    }

    cancelBackgroundSubagent(id: string): boolean {
        return this.backgroundSubagents.cancel(id);
    }

    inspectWorkflow(runId: string): WorkflowRunSummaryV1 | undefined {
        return this.workflows.inspect(runId);
    }

    controlWorkflow(runId: string, action: WorkflowControlAction, agentId?: string): Promise<string | undefined> {
        return this.workflows.control(runId, action, agentId);
    }

    async abort(): Promise<void> {
        if (this.session.isCompacting) this.session.abortCompaction();
        if (this.session.isBashRunning) this.session.abortBash();
        try {
            await this.session.abort();
        } finally {
            this.toolExecutions = new Map();
            this.runningBash = undefined;
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
        this.extensionDialogs.close();
        this.workflows.dispose();
        this.backgroundSubagents.dispose();
        this.unsubscribeSession?.();
        this.eventBus.clear();
        this.currentSnapshot = { ...this.currentSnapshot, backgroundSubagents: [], workflows: [] };
        this.runtime.setRebindSession(undefined);
        this.toolExecutions = new Map();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        this.toasts.dispose();
        await this.runtime.dispose();
        this.listeners.clear();
    }
}
