import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, Index, Match, Show, Switch } from "solid-js";
import { theme } from "../theme.js";
import { cycleIndex, isDismissKey, isEnterKey } from "./keys.js";

export interface PickerItem {
    label: string;
    detail?: string;
    search: string;
    action: () => void;
}

export type DialogState = (
    | {
          kind: "picker";
          title: string;
          placeholder: string;
          items: PickerItem[];
          loading?: boolean;
      }
    | { kind: "help" }
    | { kind: "confirm"; title: string; message: string; confirmLabel: string; action: () => void }
    | { kind: "input"; title: string; placeholder?: string; action: (value: string) => void }
) & { extensionRequestId?: number };

export function Dialog(props: { state: DialogState; width: number; height: number; onClose: () => void }) {
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
            <Switch>
                <Match when={props.state.kind === "picker"}>
                    <Picker
                        state={props.state as Extract<DialogState, { kind: "picker" }>}
                        width={Math.max(1, Math.min(82, props.width - 4))}
                        height={Math.max(1, Math.min(28, props.height - 4))}
                        onClose={props.onClose}
                    />
                </Match>
                <Match when={props.state.kind === "confirm"}>
                    <Confirmation
                        state={props.state as Extract<DialogState, { kind: "confirm" }>}
                        width={Math.max(1, Math.min(64, props.width - 4))}
                        onClose={props.onClose}
                    />
                </Match>
                <Match when={props.state.kind === "input"}>
                    <DialogInput
                        state={props.state as Extract<DialogState, { kind: "input" }>}
                        width={Math.max(1, Math.min(64, props.width - 4))}
                        onClose={props.onClose}
                    />
                </Match>
                <Match when={props.state.kind === "help"}>
                    <Help width={Math.max(1, Math.min(72, props.width - 4))} onClose={props.onClose} />
                </Match>
            </Switch>
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
        item?.action();
    }

    useKeyboard((key: KeyEvent) => {
        if (isDismissKey(key)) {
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
        if (isEnterKey(key.name)) {
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
                <Show when={!props.state.loading} fallback={<text fg={theme.muted}>Loading…</text>}>
                    <Show when={windowed().length > 0} fallback={<text fg={theme.muted}>No matches</text>}>
                        <Index each={windowed()}>
                            {(entry) => (
                                // biome-ignore lint/a11y/noStaticElementInteractions: This is an interactive OpenTUI box, not a DOM element.
                                <box
                                    height={2}
                                    backgroundColor={entry().index === selected() ? theme.selection : theme.panel}
                                    paddingLeft={1}
                                    paddingRight={1}
                                    onMouseUp={() => entry().item.action()}
                                >
                                    <text fg={entry().index === selected() ? theme.text : theme.subtle} wrapMode="none">
                                        {entry().index === selected() ? "› " : "  "}
                                        {entry().item.label}
                                    </text>
                                    <Show when={entry().item.detail}>
                                        <text fg={theme.muted} wrapMode="none">
                                            {" "}
                                            {entry().item.detail}
                                        </text>
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

function Confirmation(props: { state: Extract<DialogState, { kind: "confirm" }>; width: number; onClose: () => void }) {
    useKeyboard((key) => {
        if (isDismissKey(key) || key.name === "n") {
            key.preventDefault();
            key.stopPropagation();
            props.onClose();
            return;
        }
        if (key.name === "y" || isEnterKey(key.name)) {
            key.preventDefault();
            key.stopPropagation();
            props.state.action();
        }
    });
    return (
        <box width={props.width} backgroundColor={theme.panel} border borderColor={theme.warning} padding={2} gap={1}>
            <text fg={theme.warning}>
                <strong>{props.state.title}</strong>
            </text>
            <text fg={theme.text}>{props.state.message}</text>
            <text fg={theme.warning}>Enter/Y {props.state.confirmLabel} · Esc/N cancel</text>
        </box>
    );
}

function DialogInput(props: { state: Extract<DialogState, { kind: "input" }>; width: number; onClose: () => void }) {
    const [value, setValue] = createSignal("");
    useKeyboard((key) => {
        if (isDismissKey(key)) {
            key.preventDefault();
            key.stopPropagation();
            props.onClose();
        }
    });
    return (
        <box width={props.width} backgroundColor={theme.panel} border borderColor={theme.border} padding={2} gap={1}>
            <text fg={theme.text}>
                <strong>{props.state.title}</strong>
            </text>
            <input
                focused
                placeholder={props.state.placeholder}
                textColor={theme.text}
                backgroundColor={theme.element}
                onInput={setValue}
                onSubmit={() => props.state.action(value())}
            />
            <text fg={theme.muted}>Enter submit · Esc cancel</text>
        </box>
    );
}

function Help(props: { width: number; onClose: () => void }) {
    useKeyboard((key) => {
        if (isDismissKey(key) || key.name === "return") {
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
            <text fg={theme.muted}>Enter send / steer while working</text>
            <text fg={theme.muted}>Shift+Enter insert a new line</text>
            <text fg={theme.muted}>Alt+Enter queue a follow-up</text>
            <text fg={theme.muted}>Up / Down or Ctrl+P / Ctrl+N prompt history</text>
            <text fg={theme.muted}>Ctrl+G edit in nvim with last agent response</text>
            <text fg={theme.muted}>Escape abort the current operation</text>
            <text fg={theme.muted}>Esc/Ctrl+C return from workflow status</text>
            <text fg={theme.muted}>Shift+Tab cycle thinking level</text>
            <text fg={theme.muted}>Alt+N / Alt+P cycle models</text>
            <text fg={theme.muted}>Ctrl+L model picker</text>
            <text fg={theme.muted}>Ctrl+R session picker</text>
            <text fg={theme.muted}>Ctrl+K command palette</text>
            <text fg={theme.muted}>Ctrl+O tool output</text>
            <text fg={theme.muted}>Ctrl+T reasoning blocks</text>
            <text fg={theme.muted}>Ctrl+B sidebar</text>
            <text fg={theme.muted}>PageUp/Down scroll transcript</text>
            <text fg={theme.muted}>Ctrl+Shift+C copy highlighted text</text>
            <text fg={theme.muted}>Ctrl+C/D abort, clear, or quit</text>
            <text fg={theme.primary}>Slash commands and !shell commands are supported.</text>
            <text fg={theme.muted}>Press Esc or Enter to close.</text>
        </box>
    );
}
