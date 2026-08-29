import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { isTerminalSubagentStatus } from "#modules/subagents/interfaces/ui.js";
import { errorMessage } from "#shared/lib/validate.js";
import type { PuiController } from "../state/controller.js";
import { shouldTriggerPromptAutocomplete } from "../state/prompt-autocomplete.js";
import type { PromptAction, PromptCompletions, PuiSnapshot } from "../state/types.js";
import { copyCurrentSelection, editPromptInEditor, isCopyShortcut, PromptHistory, trapFocus } from "./app-support.js";
import { Dialog, type DialogState, extensionDialogState, type PickerItem } from "./dialogs.js";
import {
    canNavigatePromptHistory,
    cycleIndex,
    extensionConfirmKeyIntent,
    globalKeyIntent,
    isEnterKey,
    listNavigationDirection,
    promptHistoryDirection,
} from "./keys.js";
import { createMenus } from "./menus.js";
import { Prompt, PromptAutocomplete } from "./prompt.js";
import { Sidebar, ToastStack } from "./sidebar.js";
import { theme } from "./theme.js";
import { ExtensionConfirmation, MessageItem, QueuedMessage, Welcome } from "./transcript.js";

export function App(props: { controller: PuiController; initialPrompt?: string }) {
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
        const initialPrompt = props.initialPrompt;
        if (initialPrompt) {
            // Defer past the first render so dialogs opened by the prompt land on a mounted UI.
            const timer = setTimeout(() => dispatchPrompt(initialPrompt), 0);
            onCleanup(() => clearTimeout(timer));
        }
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
        const next = extensionDialogState(request, {
            resolve: (id, value) => props.controller.resolveExtensionDialog(id, value),
            close: () => setDialog(undefined),
        });
        if (next) setDialog(next);
        else if (owner !== undefined) setDialog(undefined);
    });

    createEffect(() => {
        const state = snapshot;
        const name = state.sessionName ? ` · ${state.sessionName}` : "";
        renderer.setTerminalTitle(`Pi${name}`);
        if (state.exitRequested && !renderer.isDestroyed) renderer.destroy();
    });

    createEffect(() => {
        if (!snapshot.backgroundSubagents.some((job) => !isTerminalSubagentStatus(job.status))) return;
        setElapsedNow(Date.now());
        const timer = setInterval(() => setElapsedNow(Date.now()), 1_000);
        onCleanup(() => clearInterval(timer));
    });

    const wide = createMemo(() => dimensions().width >= 112);
    const sidebarVisible = createMemo(() => dimensions().width >= 72 && (sidebarOverride() ?? wide()));
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
            const edited = await editPromptInEditor(draft, reference, snapshot.cwd);
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

    function dispatchPrompt(value: string, delivery: "steer" | "followUp" = "steer"): void {
        const action = props.controller.handlePrompt(value, delivery);
        clearPrompt();
        const promptActions: Record<PromptAction, () => void> = {
            sent: () => {},
            ignored: () => {},
            models: () => void menus.openModels(),
            sessions: () => void menus.openSessions(),
            subagents: menus.openSubagents,
            commands: menus.openCommands,
            help: () => setDialog({ kind: "help" }),
        };
        promptActions[action]();
    }

    function submit(delivery: "steer" | "followUp" = "steer"): void {
        const value = prompt?.plainText ?? promptText();
        if (!value.trim()) return;
        promptHistory.add(value);
        dispatchPrompt(value, delivery);
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
            const completionDirection = listNavigationDirection(key);
            if (completionDirection !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                setCompletionIndex((index) => cycleIndex(index, completionDirection, completions.items.length));
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
        switch (globalKeyIntent(key)) {
            case "queue-follow-up":
                key.preventDefault();
                key.stopPropagation();
                submit("followUp");
                return;
            case "interrupt":
                key.preventDefault();
                if (snapshot.isStreaming || snapshot.isCompacting) void props.controller.abort();
                else if ((prompt?.plainText ?? promptText()).length > 0) clearPrompt();
                else props.controller.requestExit();
                return;
            case "quit":
                if (prompt?.plainText ?? promptText()) return;
                key.preventDefault();
                props.controller.requestExit();
                return;
            case "external-editor":
                key.preventDefault();
                key.stopPropagation();
                void openExternalEditor();
                return;
            case "abort":
                if (!snapshot.isStreaming && !snapshot.isCompacting) return;
                key.preventDefault();
                void props.controller.abort();
                return;
            case "cycle-thinking":
                key.preventDefault();
                props.controller.cycleThinking();
                return;
            case "open-models":
                key.preventDefault();
                void menus.openModels();
                return;
            case "open-sessions":
                key.preventDefault();
                void menus.openSessions();
                return;
            case "open-commands":
                key.preventDefault();
                menus.openCommands();
                return;
            case "toggle-sidebar":
                key.preventDefault();
                setSidebarOverride(!sidebarVisible());
                return;
            case "toggle-tool-details":
                key.preventDefault();
                setToolsExpanded((value) => !value);
                return;
            case "toggle-thinking-details":
                key.preventDefault();
                setThinkingExpanded((value) => !value);
                return;
            case "cycle-model-forward":
                key.preventDefault();
                void props.controller.cycleModel("forward");
                return;
            case "cycle-model-backward":
                key.preventDefault();
                void props.controller.cycleModel("backward");
                return;
            case "page-up":
                if (!transcript) return;
                key.preventDefault();
                transcript.scrollBy(-Math.max(4, transcript.height - 4));
                return;
            case "page-down":
                if (!transcript) return;
                key.preventDefault();
                transcript.scrollBy(Math.max(4, transcript.height - 4));
                return;
            default:
                return;
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
                                {(message) => <QueuedMessage message={message()} label="steer" color={theme.primary} />}
                            </Index>
                            <Index each={snapshot.queuedFollowUp}>
                                {(message) => (
                                    <QueuedMessage message={message()} label="follow up" color={theme.secondary} />
                                )}
                            </Index>
                            <Show when={extensionConfirm()}>
                                {(request) => (
                                    <ExtensionConfirmation title={request().title} message={request().message} />
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
