/** Common validation helpers for extension-owned wire protocols. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Bound UTF-16 text without splitting a Unicode code point. */
export function boundedString(value: string, maximum: number): string {
    const limit = Number.isFinite(maximum) ? Math.floor(maximum) : maximum;
    if (Number.isNaN(limit) || limit <= 0) return "";
    if (value.length <= limit) return value;
    let result = "";
    for (const character of value) {
        if (result.length + character.length > limit - 1) break;
        result += character;
    }
    return `${result}…`;
}
