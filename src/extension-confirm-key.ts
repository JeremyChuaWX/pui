export type ExtensionConfirmKeyIntent = "approve" | "deny" | "page-up" | "page-down" | "suppress";

export interface ExtensionConfirmKey {
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
