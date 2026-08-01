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
