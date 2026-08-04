import type { KeyEvent } from "@opentui/core";

/** Keyboard predicates shared by the app shell and its dialogs. */

export const dismissKeyHint = "Esc/Ctrl+C";

/** Dismissal shortcut for dialogs and the read-only workflow status page. */
export function isDismissKey(key: Pick<KeyEvent, "name" | "ctrl">): boolean {
    return key.name.toLowerCase() === "escape" || (key.ctrl && key.name.toLowerCase() === "c");
}

export function isEnterKey(name: string): boolean {
    return ["return", "enter", "linefeed"].includes(name);
}

export function cycleIndex(index: number, delta: -1 | 1, itemCount: number): number {
    if (itemCount <= 0) return 0;
    return (((index + delta) % itemCount) + itemCount) % itemCount;
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
