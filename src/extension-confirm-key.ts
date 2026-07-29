export type ExtensionConfirmKeyIntent = "approve" | "deny" | "page-up" | "page-down" | "suppress";

export interface ExtensionConfirmKey {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
}

export function extensionConfirmKeyIntent(key: ExtensionConfirmKey): ExtensionConfirmKeyIntent {
    if (key.ctrl && !key.shift && !key.meta && !key.option && key.name === "c") return "deny";

    const unmodified = !key.ctrl && !key.meta && !key.option;
    if (unmodified && (key.name === "y" || key.name === "n")) return key.name === "y" ? "approve" : "deny";
    if (unmodified && !key.shift && key.name === "escape") return "deny";
    if (unmodified && !key.shift && ["return", "enter", "linefeed"].includes(key.name)) return "approve";
    if (unmodified && !key.shift && key.name === "pageup") return "page-up";
    if (unmodified && !key.shift && key.name === "pagedown") return "page-down";
    return "suppress";
}
