import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { errorMessage } from "../extensions/shared/validate.js";
import { copyCurrentSelection, editPromptInNvim, isCopyShortcut, PromptHistory, trapFocus } from "./app-support.js";
import type { PuiController } from "./controller.js";
import { shouldTriggerPromptAutocomplete } from "./prompt-autocomplete.js";
import { isTerminalSubagentStatus } from "./subagent.js";
import { theme } from "./theme.js";
import type { PromptCompletions, PuiSnapshot } from "./types.js";
import { Dialog, type DialogState, type PickerItem } from "./ui/dialogs.js";
import {
    canNavigatePromptHistory,
    cycleIndex,
    extensionConfirmKeyIntent,
    isDismissKey,
    isEnterKey,
    promptHistoryDirection,
} from "./ui/keys.js";
import { createMenus } from "./ui/menus.js";
import { Prompt, PromptAutocomplete } from "./ui/prompt.js";
import { activeSubagentItems, Sidebar, ToastStack } from "./ui/sidebar.js";
import { ExtensionConfirmation, MessageItem, QueuedMessage, Welcome } from "./ui/transcript.js";
import { WorkflowPage } from "./ui/workflow-page.js";

const WORKFLOW_REQUEST_TIMEOUT_MS = 30_000;

export function App(props: { controller: PuiController }) {
    const renderer = useRenderer();
    const dimensions = useTerminalDimensions();
    const [snapshot, setSnapshot] = createStore<PuiSnapshot>(props.controller.snapshot());
    const [dialog, setDialog] = createSignal<DialogState>();
    const [promptText, setPromptText] = createSignal("");
    const [promptCompletions, setPromptCompletions] = createSignal<PromptCompletions>();
    const [completionIndex, setCompletionIndex] = createSignal(0);
    const [sidebarOverride, setSidebarOverride] = createSignal<boolean>();
    const [toolsExpanded, setToolsExpanded] = createSignal(false);
    const [thinkingExpanded, setThinkingExpanded] = createSignal(false);
    const [activeWorkflowRunId, setActiveWorkflowRunId] = createSignal<string>();
    const [pendingWorkflowRun, setPendingWorkflowRun] = createSignal<{
        ids: ReadonlySet<string>;
        requestedAt: number;
        sessionId: string;
    }>();
    const [elapsedNow, setElapsedNow] = createSignal(Date.now());
    const promptHistory = new PromptHistory();
    let prompt: TextareaRenderable | undefined;
    let promptAnchor: BoxRenderable | undefined;
    let transcript: ScrollBoxRenderable | undefined;
    let dialogRequest = 0;
    let resolvedExtensionConfirmId: number | undefined;
    let completionRequest = 0;
    let completionAbort: AbortController | undefined;
    let externalEditorOpen = false;
    let appliedHistoryText: string | undefined;
    let releasePromptFocusTrap: (() => void) | undefined;

    const extensionConfirm = createMemo(() => {
        const request = snapshot.extensionDialog;
        return !dialog() && request?.kind === "confirm" ? request : undefined;
    });
    const extensionConfirmActive = createMemo(() => extensionConfirm() !== undefined);

    function resolveExtensionConfirm(id: number, approved: boolean): void {
        if (resolvedExtensionConfirmId === id) return;
        resolvedExtensionConfirmId = id;
        props.controller.resolveExtensionDialog(id, approved);
    }

    function setPromptRef(value: TextareaRenderable): void {
        releasePromptFocusTrap?.();
        prompt = value;
        releasePromptFocusTrap = trapFocus(
            value,
            () => !dialog() && !extensionConfirmActive() && !externalEditorOpen && !renderer.isDestroyed,
        );
    }

    let unsubscribe: (() => void) | undefined;
    onMount(() => {
        unsubscribe = props.controller.subscribe((next) => setSnapshot(reconcile(next)));
    });
    onCleanup(() => {
        dialogRequest += 1;
        completionRequest += 1;
        completionAbort?.abort();
        releasePromptFocusTrap?.();
        unsubscribe?.();
    });

    createEffect(() => {
        const request = snapshot.extensionDialog;
        const owner = dialog()?.extensionRequestId;
        if (dialog() && owner === undefined) return;
        if (!request) {
            if (owner !== undefined) setDialog(undefined);
            return;
        }
        if (owner === request.id) return;
        if (request.kind === "confirm") {
            if (owner !== undefined) setDialog(undefined);
        } else if (request.kind === "select") {
            setDialog({
                kind: "picker",
                title: request.title,
                placeholder: "Choose an option",
                extensionRequestId: request.id,
                items: request.options.map((option) => ({
                    label: option,
                    search: option.toLowerCase(),
                    action: () => {
                        props.controller.resolveExtensionDialog(request.id, option);
                        setDialog(undefined);
                    },
                })),
            });
        } else {
            setDialog({
                kind: "input",
                title: request.title,
                placeholder: request.placeholder,
                extensionRequestId: request.id,
                action: (value) => {
                    props.controller.resolveExtensionDialog(request.id, value);
                    setDialog(undefined);
                },
            });
        }
    });

    createEffect(() => {
        const state = snapshot;
        const name = state.sessionName ? ` · ${state.sessionName}` : "";
        renderer.setTerminalTitle(`Pi${name}`);
        if (state.exitRequested && !renderer.isDestroyed) renderer.destroy();
    });

    createEffect(() => {
        const pending = pendingWorkflowRun();
        if (!pending) return;
        if (
            pending.sessionId !== snapshot.sessionId ||
            Date.now() - pending.requestedAt >= WORKFLOW_REQUEST_TIMEOUT_MS
        ) {
            setPendingWorkflowRun(undefined);
            return;
        }
        const run = snapshot.workflows
            .filter((candidate) => !pending.ids.has(candidate.id) && candidate.updatedAt >= pending.requestedAt)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (run) {
            setActiveWorkflowRunId(run.id);
            setPendingWorkflowRun(undefined);
            return;
        }
        const timer = setTimeout(
            () => setPendingWorkflowRun((current) => (current === pending ? undefined : current)),
            WORKFLOW_REQUEST_TIMEOUT_MS - (Date.now() - pending.requestedAt),
        );
        onCleanup(() => clearTimeout(timer));
    });

    createEffect(() => {
        const runId = activeWorkflowRunId();
        onCleanup(() => {
            transcript = undefined;
            if (!runId) {
                prompt = undefined;
                promptAnchor = undefined;
                releasePromptFocusTrap?.();
                releasePromptFocusTrap = undefined;
            }
        });
    });

    createEffect(() => {
        const runId = activeWorkflowRunId();
        if (runId && !snapshot.workflows.some((run) => run.id === runId)) setActiveWorkflowRunId(undefined);
    });

    createEffect(() => {
        if (
            activeSubagentItems(snapshot.display).length === 0 &&
            !snapshot.backgroundSubagents.some((job) => !isTerminalSubagentStatus(job.status))
        )
            return;
        setElapsedNow(Date.now());
        const timer = setInterval(() => setElapsedNow(Date.now()), 1_000);
        onCleanup(() => clearInterval(timer));
    });

    const wide = createMemo(() => dimensions().width >= 112);
    const sidebarVisible = createMemo(() => dimensions().width >= 72 && (sidebarOverride() ?? wide()));
    const activeWorkflowRun = createMemo(() => snapshot.workflows.find((run) => run.id === activeWorkflowRunId()));

    function closeWorkflowPage(): void {
        setActiveWorkflowRunId(undefined);
        setPendingWorkflowRun(undefined);
        setTimeout(() => {
            if (dialog() || extensionConfirmActive() || externalEditorOpen) return;
            if (prompt && !prompt.isDestroyed) prompt.focus();
        }, 0);
    }

    function closePromptCompletions(): void {
        completionRequest += 1;
        completionAbort?.abort();
        completionAbort = undefined;
        setPromptCompletions(undefined);
        setCompletionIndex(0);
    }

    createEffect(() => {
        if (extensionConfirmActive()) closePromptCompletions();
    });

    async function updatePromptCompletions(text: string, cursorOffset: number): Promise<void> {
        if (promptHistory.isTraversing || !shouldTriggerPromptAutocomplete(text, cursorOffset)) {
            closePromptCompletions();
            return;
        }

        const request = ++completionRequest;
        completionAbort?.abort();
        const abort = new AbortController();
        completionAbort = abort;
        let result: PromptCompletions | undefined;
        try {
            result = await props.controller.getPromptCompletions(text, cursorOffset, abort.signal);
        } catch {
            if (request === completionRequest) setPromptCompletions(undefined);
            return;
        }
        if (request !== completionRequest || abort.signal.aborted || promptHistory.isTraversing) return;
        if (!result || result.items.length === 0) {
            setPromptCompletions(undefined);
            setCompletionIndex(0);
            return;
        }
        setPromptCompletions(result);
        setCompletionIndex(0);
    }

    function handlePromptChange(): void {
        const value = prompt?.plainText ?? promptText();
        const applyingHistory = value === appliedHistoryText;
        appliedHistoryText = undefined;
        if (!applyingHistory) promptHistory.resetBrowsing();
        setPromptText(value);
        const cursorOffset = prompt?.cursorOffset ?? value.length;
        void updatePromptCompletions(value, cursorOffset);
    }

    function handlePromptCursorChange(): void {
        setTimeout(() => {
            if (!prompt || prompt.isDestroyed) return;
            void updatePromptCompletions(prompt.plainText, prompt.cursorOffset);
        }, 0);
    }

    function applyPromptCompletion(): void {
        const completions = promptCompletions();
        const input = prompt;
        if (!completions || !input) return;
        const item = completions.items[completionIndex()];
        if (!item) return;
        const applied = props.controller.applyPromptCompletion(
            input.plainText,
            input.cursorOffset,
            item,
            completions.prefix,
        );
        if (!applied) return;

        closePromptCompletions();
        promptHistory.resetBrowsing();
        input.setText(applied.text);
        input.cursorOffset = applied.cursorOffset;
        setPromptText(applied.text);
        setTimeout(() => {
            if (!prompt || prompt.isDestroyed) return;
            void updatePromptCompletions(prompt.plainText, prompt.cursorOffset);
        }, 0);
    }

    function clearPrompt(): void {
        closePromptCompletions();
        promptHistory.resetBrowsing();
        appliedHistoryText = undefined;
        prompt?.clear();
        setPromptText("");
    }

    function navigatePromptHistory(direction: "previous" | "next"): boolean {
        if (!prompt || prompt.isDestroyed) return false;
        const value = direction === "previous" ? promptHistory.previous(prompt.plainText) : promptHistory.next();
        if (value === undefined) return false;

        closePromptCompletions();
        appliedHistoryText = value;
        prompt.setText(value);
        prompt.cursorOffset = value.length;
        setPromptText(value);
        return true;
    }

    async function openExternalEditor(): Promise<void> {
        if (externalEditorOpen) return;
        externalEditorOpen = true;
        closePromptCompletions();

        const draft = prompt?.plainText ?? promptText();
        const reference = props.controller.getLastAssistantText();
        let suspended = false;
        let failure: unknown;

        try {
            renderer.suspend();
            suspended = true;
            process.stdout.write("Launching nvim. pui will resume when the editor exits.\n");
            const edited = await editPromptInNvim(draft, reference, snapshot.cwd);
            if (edited !== undefined && prompt && !prompt.isDestroyed) {
                promptHistory.resetBrowsing();
                prompt.setText(edited);
                prompt.cursorOffset = edited.length;
                setPromptText(edited);
            }
        } catch (error) {
            failure = error;
        } finally {
            if (suspended && !renderer.isDestroyed) renderer.resume();
            externalEditorOpen = false;
            setTimeout(() => prompt?.focus(), 0);
        }

        if (failure) {
            props.controller.notify(`Could not open nvim: ${errorMessage(failure)}`, "error");
        }
    }

    async function openAsyncPicker(
        title: string,
        placeholder: string,
        load: () => Promise<PickerItem[]>,
    ): Promise<void> {
        closePromptCompletions();
        const request = ++dialogRequest;
        setDialog({ kind: "picker", title, placeholder, loading: true, items: [] });
        try {
            const items = await load();
            if (request !== dialogRequest) return;
            setDialog({
                kind: "picker",
                title,
                placeholder,
                items: items.map((item) => ({
                    ...item,
                    action: () => {
                        setDialog(undefined);
                        item.action();
                    },
                })),
            });
        } catch (error) {
            if (request !== dialogRequest) return;
            setDialog(undefined);
            props.controller.notify(errorMessage(error), "error");
        }
    }

    const menus = createMenus({
        controller: props.controller,
        snapshot: () => snapshot,
        openDialog: setDialog,
        closeDialog: () => setDialog(undefined),
        openAsyncPicker,
        closeCompletions: closePromptCompletions,
        toggleToolDetails: () => setToolsExpanded((value) => !value),
        openExternalEditor: () => void openExternalEditor(),
    });

    function submit(delivery: "steer" | "followUp" = "steer"): void {
        const value = prompt?.plainText ?? promptText();
        if (!value.trim()) return;
        promptHistory.add(value);
        const workflowRequest = {
            ids: new Set(snapshot.workflows.map((run) => run.id)),
            requestedAt: Date.now(),
            sessionId: snapshot.sessionId,
        };
        const action = props.controller.handlePrompt(value, delivery);
        clearPrompt();
        if (action === "workflow") setPendingWorkflowRun(workflowRequest);
        if (action === "models") void menus.openModels();
        if (action === "sessions") void menus.openSessions();
        if (action === "subagents") menus.openSubagents();
        if (action === "workflows") menus.openWorkflows();
        if (action === "commands") menus.openCommands();
        if (action === "help") setDialog({ kind: "help" });
    }

    useKeyboard((key) => {
        if (isCopyShortcut(key, renderer.hasSelection)) {
            key.preventDefault();
            key.stopPropagation();
            void copyCurrentSelection(renderer)
                .then((copied) => {
                    if (copied) props.controller.notify("Copied highlighted text", "success");
                })
                .catch((error: unknown) => props.controller.notify(errorMessage(error), "error"));
            return;
        }
        const confirmation = extensionConfirm();
        if (confirmation) {
            key.preventDefault();
            key.stopPropagation();
            const intent = extensionConfirmKeyIntent(key);
            if (intent === "approve") resolveExtensionConfirm(confirmation.id, true);
            else if (intent === "deny") resolveExtensionConfirm(confirmation.id, false);
            else if (intent === "page-up" && transcript) transcript.scrollBy(-Math.max(4, transcript.height - 4));
            else if (intent === "page-down" && transcript) transcript.scrollBy(Math.max(4, transcript.height - 4));
            return;
        }
        if (dialog()) return;

        if (activeWorkflowRun() && isDismissKey(key)) {
            key.preventDefault();
            key.stopPropagation();
            closeWorkflowPage();
            return;
        }

        const historyDirection = promptHistoryDirection(key);
        if (
            historyDirection &&
            promptHistory.isTraversing &&
            canNavigatePromptHistory(prompt, historyDirection) &&
            navigatePromptHistory(historyDirection)
        ) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }

        const completions = promptCompletions();
        if (completions) {
            if (key.name === "escape") {
                key.preventDefault();
                key.stopPropagation();
                closePromptCompletions();
                return;
            }
            if (key.name === "up" || (key.ctrl && key.name === "p")) {
                key.preventDefault();
                key.stopPropagation();
                setCompletionIndex((index) => cycleIndex(index, -1, completions.items.length));
                return;
            }
            if (key.name === "down" || (key.ctrl && key.name === "n")) {
                key.preventDefault();
                key.stopPropagation();
                setCompletionIndex((index) => cycleIndex(index, 1, completions.items.length));
                return;
            }
            const confirm =
                key.name === "tab" || (!key.shift && !key.ctrl && !key.meta && !key.option && isEnterKey(key.name));
            if (confirm) {
                key.preventDefault();
                key.stopPropagation();
                applyPromptCompletion();
                return;
            }
        }

        if (
            historyDirection &&
            canNavigatePromptHistory(prompt, historyDirection) &&
            navigatePromptHistory(historyDirection)
        ) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        if ((key.meta || key.option) && isEnterKey(key.name)) {
            key.preventDefault();
            key.stopPropagation();
            submit("followUp");
            return;
        }
        if (key.ctrl && key.name === "c") {
            key.preventDefault();
            if (snapshot.isStreaming || snapshot.isCompacting) void props.controller.abort();
            else if ((prompt?.plainText ?? promptText()).length > 0) clearPrompt();
            else props.controller.requestExit();
            return;
        }
        if (key.ctrl && key.name === "d" && !(prompt?.plainText ?? promptText())) {
            key.preventDefault();
            props.controller.requestExit();
            return;
        }
        if (key.ctrl && key.name === "g") {
            key.preventDefault();
            key.stopPropagation();
            void openExternalEditor();
            return;
        }
        if (key.name === "escape" && (snapshot.isStreaming || snapshot.isCompacting)) {
            key.preventDefault();
            void props.controller.abort();
            return;
        }
        if (key.shift && key.name === "tab") {
            key.preventDefault();
            props.controller.cycleThinking();
            return;
        }
        if (key.ctrl && key.name === "l") {
            key.preventDefault();
            void menus.openModels();
            return;
        }
        if (key.ctrl && key.name === "r") {
            key.preventDefault();
            void menus.openSessions();
            return;
        }
        if (key.ctrl && key.name === "k") {
            key.preventDefault();
            menus.openCommands();
            return;
        }
        if (key.ctrl && key.name === "b") {
            key.preventDefault();
            setSidebarOverride(!sidebarVisible());
            return;
        }
        if (key.ctrl && key.name === "o") {
            key.preventDefault();
            setToolsExpanded((value) => !value);
            return;
        }
        if (key.ctrl && key.name === "t") {
            key.preventDefault();
            setThinkingExpanded((value) => !value);
            return;
        }
        if ((key.meta || key.option) && (key.name === "n" || key.name === "p")) {
            key.preventDefault();
            void props.controller.cycleModel(key.name === "n" ? "forward" : "backward");
            return;
        }
        if (key.name === "pageup" && transcript) {
            key.preventDefault();
            transcript.scrollBy(-Math.max(4, transcript.height - 4));
            return;
        }
        if (key.name === "pagedown" && transcript) {
            key.preventDefault();
            transcript.scrollBy(Math.max(4, transcript.height - 4));
        }
    });

    return (
        <box
            width={dimensions().width}
            height={dimensions().height}
            flexDirection="column"
            backgroundColor={theme.background}
        >
            <box flexDirection="row" flexGrow={1} minHeight={0}>
                <box flexGrow={1} minWidth={0} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
                    <Show
                        when={extensionConfirmActive() ? undefined : activeWorkflowRun()}
                        fallback={
                            <>
                                <Show
                                    when={snapshot.display.length > 0 || extensionConfirmActive()}
                                    fallback={<Welcome cwd={snapshot.compactCwd} />}
                                >
                                    <scrollbox
                                        ref={(value) => (transcript = value)}
                                        flexGrow={1}
                                        minHeight={0}
                                        stickyScroll
                                        stickyStart="bottom"
                                        viewportOptions={{ paddingRight: 1 }}
                                        verticalScrollbarOptions={{
                                            visible: false,
                                            trackOptions: {
                                                backgroundColor: theme.element,
                                                foregroundColor: theme.border,
                                            },
                                        }}
                                        contentOptions={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}
                                    >
                                        <For each={snapshot.display}>
                                            {(item) => (
                                                <MessageItem
                                                    item={() => item}
                                                    toolsExpanded={toolsExpanded()}
                                                    thinkingExpanded={thinkingExpanded()}
                                                    now={elapsedNow()}
                                                />
                                            )}
                                        </For>
                                        <Index each={snapshot.queuedSteering}>
                                            {(message) => (
                                                <QueuedMessage
                                                    message={message()}
                                                    label="steer"
                                                    color={theme.primary}
                                                />
                                            )}
                                        </Index>
                                        <Index each={snapshot.queuedFollowUp}>
                                            {(message) => (
                                                <QueuedMessage
                                                    message={message()}
                                                    label="follow up"
                                                    color={theme.secondary}
                                                />
                                            )}
                                        </Index>
                                        <Show when={extensionConfirm()}>
                                            {(request) => (
                                                <ExtensionConfirmation
                                                    title={request().title}
                                                    message={request().message}
                                                />
                                            )}
                                        </Show>
                                    </scrollbox>
                                </Show>
                                <Show when={promptCompletions()}>
                                    {(completions) => (
                                        <PromptAutocomplete
                                            completions={completions()}
                                            selected={completionIndex()}
                                            anchor={() => promptAnchor}
                                        />
                                    )}
                                </Show>
                                <Prompt
                                    snapshot={snapshot}
                                    focused={!dialog() && !extensionConfirmActive()}
                                    setAnchorRef={(value) => (promptAnchor = value)}
                                    setRef={setPromptRef}
                                    onChange={handlePromptChange}
                                    onCursorChange={handlePromptCursorChange}
                                    onSubmit={() => submit("steer")}
                                />
                            </>
                        }
                    >
                        {(run) => <WorkflowPage run={run()} setRef={(value) => (transcript = value)} />}
                    </Show>
                </box>
                <Show when={sidebarVisible()}>
                    <Sidebar snapshot={snapshot} now={elapsedNow()} />
                </Show>
            </box>
            <ToastStack toasts={snapshot.toasts} width={dimensions().width} />
            <Show when={dialog()}>
                {(value) => (
                    <Dialog
                        state={value()}
                        width={dimensions().width}
                        height={dimensions().height}
                        onClose={() => {
                            dialogRequest += 1;
                            const requestId = value().extensionRequestId;
                            if (requestId !== undefined) props.controller.resolveExtensionDialog(requestId, undefined);
                            setDialog(undefined);
                            setTimeout(() => prompt?.focus(), 0);
                        }}
                    />
                )}
            </Show>
        </box>
    );
}
