import type { BoxRenderable, KeyBinding, TextareaRenderable } from "@opentui/core";
import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { formatCount } from "../format.js";
import { theme } from "../theme.js";
import type { PromptCompletions, PuiSnapshot } from "../types.js";

const promptKeyBindings: KeyBinding[] = [
    { name: "return", action: "submit" },
    { name: "kpenter", action: "submit" },
    { name: "linefeed", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "return", meta: true, action: "submit" },
];

export function PromptAutocomplete(props: {
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
                            {entry().index === props.selected ? "› " : "  "}
                            {commandPrefix()}
                            {entry().item.label}
                        </text>
                        <Show when={entry().item.description}>
                            <text fg={theme.muted} wrapMode="none">
                                {" "}
                                {entry().item.description}
                            </text>
                        </Show>
                    </box>
                )}
            </Index>
            <text fg={theme.muted}> ↑↓ navigate · tab/enter select · esc close</text>
        </box>
    );
}

export function Prompt(props: {
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
                    <text fg={theme.border}> · </text>
                    <text fg={theme.muted}>{props.snapshot.gitBranch}</text>
                </Show>
                <box flexGrow={1} />
                <text fg={theme.muted}>{formatCount(props.snapshot.contextTokens)}</text>
                <Show when={props.snapshot.contextPercent != null}>
                    <text fg={theme.muted}> ({Math.round(props.snapshot.contextPercent ?? 0)}%)</text>
                </Show>
                <text fg={theme.border}> · </text>
                <text fg={theme.text}>{props.snapshot.modelId}</text>
                <text fg={theme.secondary}> {props.snapshot.thinkingLevel}</text>
            </box>
        </box>
    );
}
