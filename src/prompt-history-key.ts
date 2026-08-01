export type PromptHistoryDirection = "previous" | "next";

export function promptHistoryDirection(key: {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
}): PromptHistoryDirection | undefined {
    const unmodified = !key.ctrl && !key.shift && !key.meta && !key.option;
    if ((unmodified && key.name === "up") || (key.ctrl && key.name === "p")) return "previous";
    if ((unmodified && key.name === "down") || (key.ctrl && key.name === "n")) return "next";
    return undefined;
}
