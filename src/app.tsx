import type { BoxRenderable, KeyBinding, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { PuiController } from "./controller.js";
import { editPromptInNvim } from "./external-editor.js";
import { trapFocus } from "./focus-trap.js";
import { formatCount } from "./format.js";
import { cycleIndex } from "./list-navigation.js";
import { shouldTriggerPromptAutocomplete } from "./prompt-autocomplete.js";
import { PromptHistory } from "./prompt-history.js";
import { copyCurrentSelection, isCopyShortcut } from "./selection-copy.js";
import {
  isTerminalSubagentStatus,
  subagentElapsed,
  subagentStatusIcon,
  subagentStatusLabel,
  subagentSummary,
  type SubagentStatus,
  type SubagentViewModel,
} from "./subagent.js";
import { syntaxStyle, theme } from "./theme.js";
import type {
  DisplayItem,
  ModelChoice,
  PuiSnapshot,
  PromptCompletions,
  SessionChoice,
  ToastMessage,
} from "./types.js";

interface PickerItem {
  label: string;
  detail?: string;
  search: string;
  value: string;
}

type ToolDisplayItem = Extract<DisplayItem, { kind: "tool" }>;

type DialogState =
  | {
      kind: "picker";
      title: string;
      placeholder: string;
      items: PickerItem[];
      loading?: boolean;
      onSelect: (value: string) => void;
    }
  | { kind: "help" };

const promptKeyBindings: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "submit" },
];

function progressBar(percent: number | null | undefined, width = 14): string {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((value / 100) * width);
  return `${"━".repeat(filled)}${"─".repeat(width - filled)}`;
}

function subagentColor(status: SubagentStatus): string {
  switch (status) {
    case "succeeded":
      return theme.success;
    case "failed":
    case "timed_out":
      return theme.error;
    case "cancelled":
    case "queued":
      return theme.muted;
    case "starting":
      return theme.info;
    case "running":
      return theme.warning;
  }
}

function activeSubagentItems(display: readonly DisplayItem[]): ToolDisplayItem[] {
  return display.filter(
    (item): item is ToolDisplayItem =>
      item.kind === "tool" && Boolean(item.subagent) && !isTerminalSubagentStatus(item.subagent!.status),
  );
}

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
  const [elapsedNow, setElapsedNow] = createSignal(Date.now());
  const promptHistory = new PromptHistory();
  let prompt: TextareaRenderable | undefined;
  let promptAnchor: BoxRenderable | undefined;
  let transcript: ScrollBoxRenderable | undefined;
  let dialogRequest = 0;
  let completionRequest = 0;
  let completionAbort: AbortController | undefined;
  let externalEditorOpen = false;
  let appliedHistoryText: string | undefined;
  let releasePromptFocusTrap: (() => void) | undefined;

  function setPromptRef(value: TextareaRenderable): void {
    releasePromptFocusTrap?.();
    prompt = value;
    releasePromptFocusTrap = trapFocus(value, () => !dialog() && !externalEditorOpen && !renderer.isDestroyed);
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
    const state = snapshot;
    const name = state.sessionName ? ` · ${state.sessionName}` : "";
    renderer.setTerminalTitle(`Pi${name}`);
    if (state.exitRequested && !renderer.isDestroyed) renderer.destroy();
  });

  createEffect(() => {
    if (activeSubagentItems(snapshot.display).length === 0) return;
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

  function navigatePromptHistory(direction: "previous" | "next"): void {
    const value = direction === "previous"
      ? promptHistory.previous(prompt?.plainText ?? promptText())
      : promptHistory.next();
    if (value === undefined || !prompt || prompt.isDestroyed) return;

    closePromptCompletions();
    appliedHistoryText = value;
    prompt.setText(value);
    prompt.cursorOffset = value.length;
    setPromptText(value);
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
      props.controller.notify(
        `Could not open nvim: ${failure instanceof Error ? failure.message : String(failure)}`,
        "error",
      );
    }
  }

  function submit(delivery: "steer" | "followUp" = "steer"): void {
    const value = prompt?.plainText ?? promptText();
    if (!value.trim()) return;
    promptHistory.add(value);
    const action = props.controller.handlePrompt(value, delivery);
    clearPrompt();
    if (action === "models") void openModels();
    if (action === "sessions") void openSessions();
    if (action === "commands") openCommands();
    if (action === "help") setDialog({ kind: "help" });
  }

  async function openModels(): Promise<void> {
    closePromptCompletions();
    const request = ++dialogRequest;
    setDialog({
      kind: "picker",
      title: "Select model",
      placeholder: "Search provider or model",
      loading: true,
      items: [],
      onSelect: () => {},
    });
    try {
      const choices = await props.controller.listModels();
      if (request !== dialogRequest) return;
      setDialog({
        kind: "picker",
        title: "Select model",
        placeholder: "Search provider or model",
        items: choices.map((choice, index) => ({
          label: choice.label,
          detail: choice.detail,
          search: choice.search,
          value: String(index),
        })),
        onSelect: (value) => {
          const choice: ModelChoice | undefined = choices[Number(value)];
          setDialog(undefined);
          if (choice) void props.controller.selectModel(choice);
        },
      });
    } catch (error) {
      setDialog(undefined);
      props.controller.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function openSessions(): Promise<void> {
    closePromptCompletions();
    const request = ++dialogRequest;
    setDialog({
      kind: "picker",
      title: "Resume session",
      placeholder: "Search session history",
      loading: true,
      items: [],
      onSelect: () => {},
    });
    try {
      const choices = await props.controller.listSessions();
      if (request !== dialogRequest) return;
      setDialog({
        kind: "picker",
        title: "Resume session",
        placeholder: "Search session history",
        items: choices.map((choice, index) => ({
          label: choice.label,
          detail: choice.detail,
          search: choice.search,
          value: String(index),
        })),
        onSelect: (value) => {
          const choice: SessionChoice | undefined = choices[Number(value)];
          setDialog(undefined);
          if (choice) void props.controller.switchSession(choice.path);
        },
      });
    } catch (error) {
      setDialog(undefined);
      props.controller.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function runCommand(command: string): void {
    setDialog(undefined);
    switch (command) {
      case "model":
        void openModels();
        break;
      case "sessions":
        void openSessions();
        break;
      case "new":
        void props.controller.newSession();
        break;
      case "compact":
        void props.controller.compact();
        break;
      case "thinking":
        props.controller.cycleThinking();
        break;
      case "tools":
        setToolsExpanded((value) => !value);
        break;
      case "editor":
        void openExternalEditor();
        break;
      case "help":
        setDialog({ kind: "help" });
        break;
      case "quit":
        props.controller.requestExit();
        break;
    }
  }

  function openCommands(): void {
    closePromptCompletions();
    const items = [
      ["Models", "Switch the active model", "model"],
      ["Sessions", "Resume a previous session", "sessions"],
      ["New session", "Start with a clean conversation", "new"],
      ["Compact context", "Summarize older conversation history", "compact"],
      ["Thinking level", "Cycle the current reasoning level", "thinking"],
      ["Tool details", "Expand or collapse tool output", "tools"],
      ["Edit in nvim", "Edit the prompt with the last agent response as reference", "editor"],
      ["Help", "Show keyboard shortcuts", "help"],
      ["Quit", "Exit pui", "quit"],
    ];
    setDialog({
      kind: "picker",
      title: "Commands",
      placeholder: "Search commands",
      items: items.map(([label = "", detail = "", value = ""]) => ({
        label,
        detail,
        value,
        search: `${label} ${detail}`.toLowerCase(),
      })),
      onSelect: runCommand,
    });
  }

  useKeyboard((key) => {
    if (isCopyShortcut(key, renderer.hasSelection)) {
      key.preventDefault();
      key.stopPropagation();
      void copyCurrentSelection(renderer)
        .then((copied) => {
          if (copied) props.controller.notify("Copied highlighted text", "success");
        })
        .catch((error: unknown) =>
          props.controller.notify(error instanceof Error ? error.message : String(error), "error"),
        );
      return;
    }
    if (dialog()) return;

    const historyKey = key.ctrl && (key.name === "p" || key.name === "n");
    if (historyKey && promptHistory.isTraversing) {
      key.preventDefault();
      key.stopPropagation();
      navigatePromptHistory(key.name === "p" ? "previous" : "next");
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
        key.name === "tab" ||
        (!key.shift && !key.ctrl && !key.meta && !key.option && ["return", "enter", "linefeed"].includes(key.name));
      if (confirm) {
        key.preventDefault();
        key.stopPropagation();
        applyPromptCompletion();
        return;
      }
    }

    if (historyKey) {
      key.preventDefault();
      key.stopPropagation();
      navigatePromptHistory(key.name === "p" ? "previous" : "next");
      return;
    }
    if ((key.meta || key.option) && ["return", "enter", "linefeed"].includes(key.name)) {
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
      void openModels();
      return;
    }
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      void openSessions();
      return;
    }
    if (key.ctrl && key.name === "k") {
      key.preventDefault();
      openCommands();
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
          <Show when={snapshot.display.length > 0} fallback={<Welcome cwd={snapshot.compactCwd} />}>
            <scrollbox
              ref={(value) => (transcript = value)}
              flexGrow={1}
              minHeight={0}
              stickyScroll
              stickyStart="bottom"
              viewportOptions={{ paddingRight: 1 }}
              verticalScrollbarOptions={{
                visible: false,
                trackOptions: { backgroundColor: theme.element, foregroundColor: theme.border },
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
                {(message) => <QueuedMessage message={message()} label="follow up" color={theme.secondary} />}
              </Index>
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
            focused={!dialog()}
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
              setDialog(undefined);
              setTimeout(() => prompt?.focus(), 0);
            }}
          />
        )}
      </Show>
    </box>
  );
}

function Welcome(props: { cwd: string }) {
  return (
    <box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center">
      <box alignItems="center" gap={1}>
        <text fg={theme.primary}>
          <strong>π</strong>
        </text>
        <text fg={theme.text}>
          <strong>What are we building?</strong>
        </text>
        <text fg={theme.muted}>{props.cwd}</text>
        <text fg={theme.muted}>Type a request, or press Ctrl+K for commands.</text>
      </box>
    </box>
  );
}

function MessageItem(props: {
  item: () => DisplayItem;
  toolsExpanded: boolean;
  thinkingExpanded: boolean;
  now: number;
}) {
  const textItem = () => props.item() as DisplayItem & { text: string; label?: string; streaming?: boolean };
  const toolItem = () => props.item() as ToolDisplayItem;
  const bashItem = () => props.item() as DisplayItem & {
    kind: "bash";
    command: string;
    output: string;
    exitCode?: number;
    cancelled: boolean;
    excluded: boolean;
    running?: boolean;
  };
  const toolColor = () => (toolItem().isError ? theme.error : toolItem().running ? theme.warning : theme.success);
  const bashColor = () =>
    bashItem().running
      ? theme.warning
      : bashItem().cancelled || (bashItem().exitCode ?? 0) !== 0
        ? theme.error
        : theme.success;

  return (
    <Switch>
      <Match when={props.item().kind === "user"}>
        <box marginTop={1} border={["left"]} borderColor={theme.primary} backgroundColor={theme.userBackground}>
          <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
            <text fg={theme.text}>{textItem().text}</text>
          </box>
        </box>
      </Match>
      <Match when={props.item().kind === "assistant"}>
        <box marginTop={1} paddingLeft={1} paddingRight={1}>
          <markdown
            syntaxStyle={syntaxStyle}
            streaming={true}
            internalBlockMode="top-level"
            content={textItem().text}
            conceal
            fg={theme.text}
            bg={theme.background}
          />
        </box>
      </Match>
      <Match when={props.item().kind === "thinking"}>
        <box marginTop={1} border={["left"]} borderColor={theme.secondary} paddingLeft={2} paddingTop={1} paddingBottom={1}>
          <text fg={theme.secondary}>◇ Reasoning</text>
          <Show when={props.thinkingExpanded} fallback={<text fg={theme.muted}>hidden · Ctrl+T to expand</text>}>
            <text fg={theme.muted}>{textItem().text}</text>
          </Show>
        </box>
      </Match>
      <Match when={props.item().kind === "tool"}>
        <Show
          when={toolItem().subagent}
          fallback={
            <box marginTop={1} border={["left"]} borderColor={toolColor()} backgroundColor={theme.toolBackground}>
              <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                <box flexDirection="row">
                  <text fg={toolColor()}>{toolItem().running ? "◌" : toolItem().isError ? "×" : "✓"} </text>
                  <text fg={theme.text}>{toolItem().title}</text>
                </box>
                <Show when={props.toolsExpanded && toolItem().args}>
                  <text fg={theme.muted}>{toolItem().args}</text>
                </Show>
                <Show when={props.toolsExpanded && toolItem().result}>
                  <text fg={toolItem().isError ? theme.error : theme.subtle}>{toolItem().result}</text>
                </Show>
                <Show when={!props.toolsExpanded && toolItem().result}>
                  <text fg={theme.muted}>Ctrl+O to show output</text>
                </Show>
              </box>
            </box>
          }
        >
          {(subagent) => (
            <SubagentTool
              item={toolItem()}
              subagent={subagent()}
              expanded={props.toolsExpanded}
              now={props.now}
            />
          )}
        </Show>
      </Match>
      <Match when={props.item().kind === "bash"}>
        <box marginTop={1} border={["left"]} borderColor={bashColor()} backgroundColor={theme.toolBackground}>
          <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
            <text fg={bashColor()}>
              {bashItem().running ? "◌" : "›"} shell{bashItem().excluded ? " · excluded" : ""}
            </text>
            <text fg={theme.text}>$ {bashItem().command}</text>
            <Show when={bashItem().output}>
              <text fg={theme.muted}>{bashItem().output}</text>
            </Show>
          </box>
        </box>
      </Match>
      <Match when={props.item().kind === "summary"}>
        <box marginTop={1} border={["left"]} borderColor={theme.secondary} paddingLeft={2} paddingTop={1}>
          <text fg={theme.secondary}>{textItem().label}</text>
          <markdown
            syntaxStyle={syntaxStyle}
            internalBlockMode="top-level"
            content={textItem().text}
            conceal
            fg={theme.muted}
            bg={theme.background}
          />
        </box>
      </Match>
      <Match when={true}>
        <box
          marginTop={1}
          border={["left"]}
          borderColor={textItem().label === "error" ? theme.error : theme.info}
          paddingLeft={2}
        >
          <text fg={textItem().label === "error" ? theme.error : theme.info}>
            {textItem().label || "message"}
          </text>
          <text fg={theme.text}>{textItem().text}</text>
        </box>
      </Match>
    </Switch>
  );
}

function SubagentTool(props: {
  item: ToolDisplayItem;
  subagent: SubagentViewModel;
  expanded: boolean;
  now: number;
}) {
  const color = () => subagentColor(props.subagent.status);
  const finalOutput = () =>
    isTerminalSubagentStatus(props.subagent.status) && !props.item.isError ? props.item.result : undefined;
  const livePreview = () =>
    !isTerminalSubagentStatus(props.subagent.status) ? props.subagent.outputPreview : undefined;
  const usageDetails = () => {
    const usage = props.subagent.usage;
    return [
      `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`,
      `${formatCount(usage.input)} in`,
      `${formatCount(usage.output)} out`,
      `${formatCount(usage.cacheRead)} cache read`,
      `${formatCount(usage.cacheWrite)} cache write`,
      `${formatCount(usage.totalTokens)} total`,
    ].join(" · ");
  };

  return (
    <box marginTop={1} border={["left"]} borderColor={color()} backgroundColor={theme.toolBackground}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" minWidth={0}>
          <text fg={color()}>{subagentStatusIcon(props.subagent.status)} </text>
          <text fg={theme.text} wrapMode="none">{subagentSummary(props.subagent, props.now)}</text>
        </box>
        <Show when={!props.expanded && props.subagent.error}>
          <text fg={theme.error} wrapMode="none">{props.subagent.error}</text>
        </Show>
        <Show when={props.expanded}>
          <box marginTop={1} gap={1}>
            <Show when={props.subagent.prompt}>
              {(prompt) => (
                <box>
                  <text fg={theme.secondary}>Delegated prompt</text>
                  <text fg={theme.text}>{prompt()}</text>
                </box>
              )}
            </Show>

            <box>
              <text fg={theme.secondary}>Run</text>
              <text fg={theme.muted}>{props.subagent.cwd || "(working directory unavailable)"}</text>
              <text fg={theme.muted}>
                {subagentStatusLabel(props.subagent.status)} · {props.subagent.model} · {subagentElapsed(props.subagent, props.now)}
              </text>
            </box>

            <Show when={props.subagent.activeTools.length > 0}>
              <box>
                <text fg={theme.secondary}>Active child tools</text>
                <For each={props.subagent.activeTools}>
                  {(tool) => <text fg={theme.warning}>◌ {tool.title}</text>}
                </For>
              </box>
            </Show>

            <Show when={props.subagent.recentActivity.length > 0}>
              <box>
                <text fg={theme.secondary}>Recent activity</text>
                <For each={props.subagent.recentActivity}>
                  {(activity) => (
                    <text fg={activity.isError ? theme.error : theme.muted}>
                      {activity.kind === "tool_start" ? "›" : activity.kind === "tool_end" ? "·" : "·"} {activity.title}
                    </text>
                  )}
                </For>
              </box>
            </Show>

            <box>
              <text fg={theme.secondary}>Usage</text>
              <text fg={theme.muted}>{usageDetails()}</text>
            </box>

            <Show when={props.subagent.error}>
              {(error) => (
                <box>
                  <text fg={theme.error}>Diagnostic</text>
                  <text fg={theme.error}>{error()}</text>
                </box>
              )}
            </Show>

            <Show when={livePreview()}>
              {(preview) => (
                <box>
                  <text fg={theme.secondary}>Live output</text>
                  <markdown
                    syntaxStyle={syntaxStyle}
                    internalBlockMode="top-level"
                    content={preview()}
                    conceal
                    fg={theme.subtle}
                    bg={theme.toolBackground}
                  />
                </box>
              )}
            </Show>

            <Show when={finalOutput()}>
              {(output) => (
                <box>
                  <text fg={theme.secondary}>Output</text>
                  <markdown
                    syntaxStyle={syntaxStyle}
                    internalBlockMode="top-level"
                    content={output()}
                    conceal
                    fg={theme.text}
                    bg={theme.toolBackground}
                  />
                </box>
              )}
            </Show>

            <Show when={props.subagent.fullOutputPath}>
              {(outputPath) => <text fg={theme.muted}>Full output: {outputPath()}</text>}
            </Show>
          </box>
        </Show>
        <Show when={!props.expanded && (finalOutput() || livePreview())}>
          <text fg={theme.muted}>Ctrl+O to show subagent details</text>
        </Show>
      </box>
    </box>
  );
}

function QueuedMessage(props: { message: string; label: string; color: string }) {
  return (
    <box marginTop={1} border={["left"]} borderColor={props.color} paddingLeft={2}>
      <text fg={props.color}>queued · {props.label}</text>
      <text fg={theme.muted}>{props.message}</text>
    </box>
  );
}

function PromptAutocomplete(props: {
  completions: PromptCompletions;
  selected: number;
  anchor: () => BoxRenderable | undefined;
}) {
  const [positionTick, setPositionTick] = createSignal(0);
  const windowed = createMemo(() => {
    const items = props.completions.items;
    const start = Math.max(0, Math.min(props.selected - 4, Math.max(0, items.length - 8)));
    return items.slice(start, start + 8).map((item, offset) => ({ item, index: start + offset }));
  });
  const height = () => windowed().length + 3;
  const commandPrefix = () => (props.completions.prefix.startsWith("/") ? "/" : "");
  const position = createMemo(() => {
    positionTick();
    const anchor = props.anchor();
    if (!anchor) return { x: 0, y: 0, width: 0 };
    return {
      x: anchor.x - (anchor.parent?.x ?? 0),
      y: anchor.y - (anchor.parent?.y ?? 0),
      width: anchor.width,
    };
  });

  onMount(() => {
    let previous = "";
    const timer = setInterval(() => {
      const anchor = props.anchor();
      if (!anchor) return;
      const next = `${anchor.x}:${anchor.y}:${anchor.width}:${anchor.height}`;
      if (next === previous) return;
      previous = next;
      setPositionTick((tick) => tick + 1);
    }, 50);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <box
      position="absolute"
      top={Math.max(0, position().y - height() - 1)}
      left={position().x}
      width={position().width}
      zIndex={100}
      backgroundColor={theme.panel}
      border={["left"]}
      borderColor={theme.border}
      paddingTop={1}
      paddingBottom={1}
    >
      <Index each={windowed()}>
        {(entry) => (
          <box
            height={1}
            flexDirection="row"
            backgroundColor={entry().index === props.selected ? theme.selection : theme.panel}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={entry().index === props.selected ? theme.text : theme.subtle} wrapMode="none">
              {entry().index === props.selected ? "› " : "  "}{commandPrefix()}{entry().item.label}
            </text>
            <Show when={entry().item.description}>
              <text fg={theme.muted} wrapMode="none">  {entry().item.description}</text>
            </Show>
          </box>
        )}
      </Index>
      <text fg={theme.muted}>  ↑↓ navigate · tab/enter select · esc close</text>
    </box>
  );
}

function Prompt(props: {
  snapshot: PuiSnapshot;
  focused: boolean;
  setAnchorRef: (value: BoxRenderable) => void;
  setRef: (value: TextareaRenderable) => void;
  onChange: () => void;
  onCursorChange: () => void;
  onSubmit: () => void;
}) {
  const border = () => (props.snapshot.isStreaming ? theme.warning : theme.primary);
  return (
    <box ref={props.setAnchorRef} flexShrink={0}>
      <box
        border={["left"]}
        borderColor={border()}
        backgroundColor={theme.userBackground}
        minHeight={1}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <textarea
          ref={props.setRef}
          focused={props.focused}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.userBackground}
          focusedBackgroundColor={theme.userBackground}
          cursorColor={theme.primary}
          selectionBg={theme.selection}
          minHeight={1}
          maxHeight={8}
          keyBindings={promptKeyBindings}
          onContentChange={() => props.onChange()}
          onCursorChange={() => props.onCursorChange()}
          onSubmit={props.onSubmit}
        />
      </box>
      <box height={1} flexDirection="row" marginTop={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.muted}>{props.snapshot.compactCwd}</text>
        <Show when={props.snapshot.gitBranch}>
          <text fg={theme.border}>  ·  </text>
          <text fg={theme.muted}>{props.snapshot.gitBranch}</text>
        </Show>
        <box flexGrow={1} />
        <text fg={theme.muted}>{formatCount(props.snapshot.contextTokens)}</text>
        <Show when={props.snapshot.contextPercent != null}>
          <text fg={theme.muted}> ({Math.round(props.snapshot.contextPercent ?? 0)}%)</text>
        </Show>
        <text fg={theme.border}>  ·  </text>
        <text fg={theme.text}>{props.snapshot.modelId}</text>
        <text fg={theme.secondary}> {props.snapshot.thinkingLevel}</text>
      </box>
    </box>
  );
}

function Sidebar(props: { snapshot: PuiSnapshot; now: number }) {
  const subagents = () => activeSubagentItems(props.snapshot.display);
  const subagentIds = () => new Set(
    props.snapshot.display
      .filter((item): item is ToolDisplayItem => item.kind === "tool" && Boolean(item.subagent))
      .map((item) => item.toolCallId),
  );
  const genericTools = () => props.snapshot.activeTools.filter((tool) => !subagentIds().has(tool.id));

  return (
    <box
      width={34}
      flexShrink={0}
      backgroundColor={theme.panel}
      border={["left"]}
      borderColor={theme.borderSubtle}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
    >
      <text fg={theme.text}>
        <strong>Session</strong>
      </text>
      <text fg={theme.muted} wrapMode="none">{props.snapshot.sessionName || props.snapshot.sessionId.slice(0, 12)}</text>
      <text fg={theme.muted} wrapMode="none">{props.snapshot.compactCwd}</text>

      <box marginTop={1}>
        <text fg={theme.text}>
          <strong>Context</strong>
        </text>
        <text fg={props.snapshot.contextPercent && props.snapshot.contextPercent > 80 ? theme.warning : theme.primary}>
          {progressBar(props.snapshot.contextPercent)} {Math.round(props.snapshot.contextPercent ?? 0)}%
        </text>
        <text fg={theme.muted}>
          {formatCount(props.snapshot.contextTokens)} / {formatCount(props.snapshot.contextWindow)} tokens
        </text>
      </box>

      <box marginTop={1}>
        <text fg={theme.text}>
          <strong>Model</strong>
        </text>
        <text fg={theme.primary} wrapMode="none">{props.snapshot.modelId}</text>
        <text fg={theme.muted} wrapMode="none">
          {props.snapshot.modelProvider || "unconfigured"} · {props.snapshot.thinkingLevel}
        </text>
      </box>

      <Show when={subagents().length > 0}>
        <box marginTop={1}>
          <text fg={theme.text}>
            <strong>Subagents</strong>
          </text>
          <For each={subagents()}>
            {(item) => (
              <text fg={subagentColor(item.subagent!.status)} wrapMode="none">
                {subagentStatusIcon(item.subagent!.status)} {item.subagent!.agent} · {subagentStatusLabel(item.subagent!.status)} · {subagentElapsed(item.subagent!, props.now)}
              </text>
            )}
          </For>
        </box>
      </Show>

      <Show when={genericTools().length > 0}>
        <box marginTop={1}>
          <text fg={theme.text}>
            <strong>Running</strong>
          </text>
          <For each={genericTools()}>
            {(tool) => <text fg={theme.warning} wrapMode="none">◌ {tool.title}</text>}
          </For>
        </box>
      </Show>

      <box flexGrow={1} />
      <text fg={theme.muted}>Ctrl+K  commands</text>
      <text fg={theme.muted}>Ctrl+G  edit in nvim</text>
      <text fg={theme.muted}>Ctrl+L  models</text>
      <text fg={theme.muted}>Ctrl+R  sessions</text>
      <text fg={theme.muted}>Ctrl+B  sidebar</text>
    </box>
  );
}

function ToastStack(props: { toasts: ToastMessage[]; width: number }) {
  return (
    <Show when={props.toasts.length > 0}>
      <box
        position="absolute"
        top={1}
        right={2}
        width={Math.min(54, Math.max(20, props.width - 6))}
        gap={1}
        zIndex={100}
      >
        <For each={props.toasts}>
          {(toast) => {
            const color =
              toast.type === "error"
                ? theme.error
                : toast.type === "warning"
                  ? theme.warning
                  : toast.type === "success"
                    ? theme.success
                    : theme.primary;
            return (
              <box border={["left"]} borderColor={color} backgroundColor={theme.element} paddingLeft={2} paddingRight={1} paddingTop={1} paddingBottom={1}>
                <text fg={color}>{toast.type}</text>
                <text fg={theme.text}>{toast.message}</text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}

function Dialog(props: { state: DialogState; width: number; height: number; onClose: () => void }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={props.width}
      height={props.height}
      backgroundColor="#000000CC"
      alignItems="center"
      justifyContent="center"
      zIndex={200}
    >
      <Show
        when={props.state.kind === "picker"}
        fallback={<Help width={Math.max(1, Math.min(72, props.width - 4))} onClose={props.onClose} />}
      >
        <Picker
          state={props.state as Extract<DialogState, { kind: "picker" }>}
          width={Math.max(1, Math.min(82, props.width - 4))}
          height={Math.max(1, Math.min(28, props.height - 4))}
          onClose={props.onClose}
        />
      </Show>
    </box>
  );
}

function Picker(props: {
  state: Extract<DialogState, { kind: "picker" }>;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const visibleCount = () => Math.max(1, Math.floor((props.height - 9) / 2));
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return needle ? props.state.items.filter((item) => item.search.includes(needle)) : props.state.items;
  });
  const windowed = createMemo(() => {
    const list = filtered();
    const count = visibleCount();
    const start = Math.max(0, Math.min(selected() - Math.floor(count / 2), Math.max(0, list.length - count)));
    return list.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }));
  });

  createEffect(() => {
    query();
    setSelected(0);
  });

  function choose(): void {
    const item = filtered()[selected()];
    if (item) props.state.onSelect(item.value);
  }

  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      key.stopPropagation();
      props.onClose();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      key.preventDefault();
      key.stopPropagation();
      setSelected((value) => cycleIndex(value, -1, filtered().length));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      key.preventDefault();
      key.stopPropagation();
      setSelected((value) => cycleIndex(value, 1, filtered().length));
      return;
    }
    if (["return", "enter", "linefeed"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      choose();
    }
  });

  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={theme.panel}
      border
      borderColor={theme.border}
      padding={1}
    >
      <text fg={theme.text}>
        <strong>{props.state.title}</strong>
      </text>
      <box height={3} marginTop={1} border={["bottom"]} borderColor={theme.borderSubtle}>
        <input
          focused
          placeholder={props.state.placeholder}
          placeholderColor={theme.muted}
          textColor={theme.text}
          backgroundColor={theme.element}
          focusedBackgroundColor={theme.element}
          focusedTextColor={theme.text}
          onInput={setQuery}
          onSubmit={choose}
        />
      </box>
      <box flexGrow={1} minHeight={0} marginTop={1}>
        <Show
          when={!props.state.loading}
          fallback={<text fg={theme.muted}>Loading…</text>}
        >
          <Show when={windowed().length > 0} fallback={<text fg={theme.muted}>No matches</text>}>
            <Index each={windowed()}>
              {(entry) => (
                <box
                  height={2}
                  backgroundColor={entry().index === selected() ? theme.selection : theme.panel}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={() => props.state.onSelect(entry().item.value)}
                >
                  <text fg={entry().index === selected() ? theme.text : theme.subtle} wrapMode="none">
                    {entry().index === selected() ? "› " : "  "}{entry().item.label}
                  </text>
                  <Show when={entry().item.detail}>
                    <text fg={theme.muted} wrapMode="none">  {entry().item.detail}</text>
                  </Show>
                </box>
              )}
            </Index>
          </Show>
        </Show>
      </box>
      <text fg={theme.muted}>↑↓ navigate · enter select · esc close</text>
    </box>
  );
}

function Help(props: { width: number; onClose: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "return" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      key.stopPropagation();
      props.onClose();
    }
  });

  return (
    <box width={props.width} backgroundColor={theme.panel} border borderColor={theme.border} padding={2} gap={1}>
      <text fg={theme.text}>
        <strong>Keyboard shortcuts</strong>
      </text>
      <text fg={theme.muted}>Enter         send / steer while working</text>
      <text fg={theme.muted}>Shift+Enter   insert a new line</text>
      <text fg={theme.muted}>Alt+Enter     queue a follow-up</text>
      <text fg={theme.muted}>Ctrl+P / Ctrl+N prompt history</text>
      <text fg={theme.muted}>Ctrl+G        edit in nvim with last agent response</text>
      <text fg={theme.muted}>Escape        abort the current operation</text>
      <text fg={theme.muted}>Shift+Tab     cycle thinking level</text>
      <text fg={theme.muted}>Alt+N / Alt+P cycle models</text>
      <text fg={theme.muted}>Ctrl+L        model picker</text>
      <text fg={theme.muted}>Ctrl+R        session picker</text>
      <text fg={theme.muted}>Ctrl+K        command palette</text>
      <text fg={theme.muted}>Ctrl+O        tool output</text>
      <text fg={theme.muted}>Ctrl+T        reasoning blocks</text>
      <text fg={theme.muted}>Ctrl+B        sidebar</text>
      <text fg={theme.muted}>PageUp/Down   scroll transcript</text>
      <text fg={theme.muted}>Ctrl+Shift+C  copy highlighted text</text>
      <text fg={theme.muted}>Ctrl+C/D      abort, clear, or quit</text>
      <text fg={theme.primary}>Slash commands and !shell commands are supported.</text>
      <text fg={theme.muted}>Press Esc or Enter to close.</text>
    </box>
  );
}
