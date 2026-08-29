import type { KeyEvent } from "@opentui/core";

/** Keyboard predicates shared by the app shell and its dialogs. */

export const dismissKeyHint = "Esc/Ctrl+C";

/** Dismissal shortcut for dialogs. */
export function isDismissKey(key: Pick<KeyEvent, "name" | "ctrl">): boolean {
    return key.name.toLowerCase() === "escape" || (key.ctrl && key.name.toLowerCase() === "c");
}

const enterKeyNames = ["return", "enter", "linefeed"] as const;

export function isEnterKey(name: string): boolean {
    return (enterKeyNames as readonly string[]).includes(name);
}

export function cycleIndex(index: number, delta: -1 | 1, itemCount: number): number {
    if (itemCount <= 0) return 0;
    return (((index + delta) % itemCount) + itemCount) % itemCount;
}

/** Up/Ctrl+P and Down/Ctrl+N list cycling shared by pickers and the autocomplete popover. */
export function listNavigationDirection(key: { name: string; ctrl?: boolean }): -1 | 1 | undefined {
    if (key.name === "up" || (key.ctrl && key.name === "p")) return -1;
    if (key.name === "down" || (key.ctrl && key.name === "n")) return 1;
    return undefined;
}

export type PromptHistoryDirection = "previous" | "next";

export function promptHistoryDirection(key: {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
}): PromptHistoryDirection | undefined {
    const unmodified = !key.ctrl && !key.shift && !key.meta && !key.option;
    const ctrlOnly = key.ctrl && !key.shift && !key.meta && !key.option;
    if ((unmodified && key.name === "up") || (ctrlOnly && key.name === "p")) return "previous";
    if ((unmodified && key.name === "down") || (ctrlOnly && key.name === "n")) return "next";
    return undefined;
}

export function canNavigatePromptHistory(
    prompt: { plainText: string; cursorOffset: number; focused: boolean; isDestroyed: boolean } | undefined,
    direction: PromptHistoryDirection,
): boolean {
    if (!prompt || prompt.isDestroyed || !prompt.focused) return false;
    const surroundingText =
        direction === "previous"
            ? prompt.plainText.slice(0, prompt.cursorOffset)
            : prompt.plainText.slice(prompt.cursorOffset);
    return !surroundingText.includes("\n");
}

export type ExtensionConfirmKeyIntent = "approve" | "deny" | "page-up" | "page-down" | "suppress";

interface ExtensionConfirmKey {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
}

type ActiveExtensionConfirmKeyIntent = Exclude<ExtensionConfirmKeyIntent, "suppress">;

interface ExtensionConfirmShortcut {
    name: string;
    intent: ActiveExtensionConfirmKeyIntent;
    label?: string;
    ctrl?: boolean;
    allowShift?: boolean;
}

const extensionConfirmShortcutGroups: readonly {
    action: string;
    shortcuts: readonly ExtensionConfirmShortcut[];
}[] = [
    {
        action: "approve",
        shortcuts: [
            { name: "return", intent: "approve", label: "Enter" },
            { name: "enter", intent: "approve" },
            { name: "linefeed", intent: "approve" },
            { name: "y", intent: "approve", label: "Y", allowShift: true },
        ],
    },
    {
        action: "deny",
        shortcuts: [
            { name: "escape", intent: "deny", label: "Esc" },
            { name: "n", intent: "deny", label: "N", allowShift: true },
            { name: "c", intent: "deny", label: "Ctrl+C", ctrl: true },
        ],
    },
    {
        action: "scroll",
        shortcuts: [
            { name: "pageup", intent: "page-up", label: "PageUp" },
            { name: "pagedown", intent: "page-down", label: "PageDown" },
        ],
    },
];

export const extensionConfirmKeyHint = extensionConfirmShortcutGroups
    .map(
        ({ action, shortcuts }) =>
            `${shortcuts.flatMap((shortcut) => (shortcut.label ? [shortcut.label] : [])).join("/")} ${action}`,
    )
    .join(" · ");

export function extensionConfirmKeyIntent(key: ExtensionConfirmKey): ExtensionConfirmKeyIntent {
    if (key.meta || key.option) return "suppress";
    for (const { shortcuts } of extensionConfirmShortcutGroups) {
        for (const shortcut of shortcuts) {
            if (
                shortcut.name === key.name &&
                Boolean(shortcut.ctrl) === Boolean(key.ctrl) &&
                (shortcut.allowShift || !key.shift)
            )
                return shortcut.intent;
        }
    }
    return "suppress";
}

export type GlobalKeyIntent =
    | "queue-follow-up"
    | "external-editor"
    | "abort"
    | "cycle-thinking"
    | "cycle-model-forward"
    | "cycle-model-backward"
    | "open-models"
    | "open-sessions"
    | "open-commands"
    | "toggle-tool-details"
    | "toggle-thinking-details"
    | "toggle-sidebar"
    | "page-up"
    | "page-down"
    | "interrupt"
    | "quit";

interface GlobalShortcut {
    names: readonly string[];
    intent: GlobalKeyIntent;
    /** When set, the modifier must be held; unset modifiers are ignored, matching the app's historical checks. */
    ctrl?: boolean;
    shift?: boolean;
    metaOrOption?: boolean;
}

/**
 * Every global shortcut, in Help display order. Groups without shortcuts are handled contextually
 * (prompt submission, history, selection copy) but still document their
 * bindings here so Help and the handlers cannot drift.
 */
const globalShortcutGroups: readonly {
    label: string;
    description: string;
    shortcuts: readonly GlobalShortcut[];
}[] = [
    { label: "Enter", description: "send / steer while working", shortcuts: [] },
    { label: "Shift+Enter", description: "insert a new line", shortcuts: [] },
    {
        label: "Alt+Enter",
        description: "queue a follow-up",
        shortcuts: [{ names: enterKeyNames, metaOrOption: true, intent: "queue-follow-up" }],
    },
    { label: "Up / Down or Ctrl+P / Ctrl+N", description: "prompt history", shortcuts: [] },
    {
        label: "Ctrl+G",
        description: "edit in nvim with last agent response",
        shortcuts: [{ names: ["g"], ctrl: true, intent: "external-editor" }],
    },
    {
        label: "Escape",
        description: "abort the current operation",
        shortcuts: [{ names: ["escape"], intent: "abort" }],
    },
    {
        label: "Shift+Tab",
        description: "cycle thinking level",
        shortcuts: [{ names: ["tab"], shift: true, intent: "cycle-thinking" }],
    },
    {
        label: "Alt+N / Alt+P",
        description: "cycle models",
        shortcuts: [
            { names: ["n"], metaOrOption: true, intent: "cycle-model-forward" },
            { names: ["p"], metaOrOption: true, intent: "cycle-model-backward" },
        ],
    },
    { label: "Ctrl+L", description: "model picker", shortcuts: [{ names: ["l"], ctrl: true, intent: "open-models" }] },
    {
        label: "Ctrl+R",
        description: "session picker",
        shortcuts: [{ names: ["r"], ctrl: true, intent: "open-sessions" }],
    },
    {
        label: "Ctrl+K",
        description: "command palette",
        shortcuts: [{ names: ["k"], ctrl: true, intent: "open-commands" }],
    },
    {
        label: "Ctrl+O",
        description: "tool output",
        shortcuts: [{ names: ["o"], ctrl: true, intent: "toggle-tool-details" }],
    },
    {
        label: "Ctrl+T",
        description: "reasoning blocks",
        shortcuts: [{ names: ["t"], ctrl: true, intent: "toggle-thinking-details" }],
    },
    { label: "Ctrl+B", description: "sidebar", shortcuts: [{ names: ["b"], ctrl: true, intent: "toggle-sidebar" }] },
    {
        label: "PageUp/Down",
        description: "scroll transcript",
        shortcuts: [
            { names: ["pageup"], intent: "page-up" },
            { names: ["pagedown"], intent: "page-down" },
        ],
    },
    { label: "Ctrl+Shift+C", description: "copy highlighted text", shortcuts: [] },
    {
        label: "Ctrl+C/D",
        description: "abort, clear, or quit",
        shortcuts: [
            { names: ["c"], ctrl: true, intent: "interrupt" },
            { names: ["d"], ctrl: true, intent: "quit" },
        ],
    },
];

/** Help dialog lines, derived from the same table that dispatches the shortcuts. */
export const globalKeyHelp: readonly { label: string; description: string }[] = globalShortcutGroups.map(
    ({ label, description }) => ({ label, description }),
);

export function globalKeyIntent(key: {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
}): GlobalKeyIntent | undefined {
    for (const { shortcuts } of globalShortcutGroups) {
        for (const shortcut of shortcuts) {
            if (
                shortcut.names.includes(key.name) &&
                (!shortcut.ctrl || key.ctrl) &&
                (!shortcut.shift || key.shift) &&
                (!shortcut.metaOrOption || key.meta || key.option)
            )
                return shortcut.intent;
        }
    }
    return undefined;
}
