const TOKEN_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function textPosition(text: string, offset: number): { lines: string[]; line: number; column: number } {
    const boundedOffset = Math.max(0, Math.min(offset, text.length));
    const before = text.slice(0, boundedOffset);
    const lines = text.split("\n");
    const line = before.split("\n").length - 1;
    const lastNewline = before.lastIndexOf("\n");
    return { lines, line, column: boundedOffset - lastNewline - 1 };
}

export function textOffset(lines: string[], line: number, column: number): number {
    let offset = 0;
    for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
    return offset + column;
}

export function shouldTriggerPromptAutocomplete(text: string, offset: number): boolean {
    const { lines, line, column } = textPosition(text, offset);
    const beforeCursor = (lines[line] ?? "").slice(0, column);
    if (beforeCursor.startsWith("/")) return true;

    let openQuote = -1;
    for (let index = 0; index < beforeCursor.length; index += 1) {
        if (beforeCursor[index] !== '"') continue;
        openQuote = openQuote === -1 ? index : -1;
    }
    if (openQuote > 0 && beforeCursor[openQuote - 1] === "@") {
        return openQuote === 1 || TOKEN_DELIMITERS.has(beforeCursor[openQuote - 2] ?? "");
    }

    let delimiter = -1;
    for (let index = beforeCursor.length - 1; index >= 0; index -= 1) {
        if (!TOKEN_DELIMITERS.has(beforeCursor[index] ?? "")) continue;
        delimiter = index;
        break;
    }
    return beforeCursor.slice(delimiter + 1).startsWith("@");
}
