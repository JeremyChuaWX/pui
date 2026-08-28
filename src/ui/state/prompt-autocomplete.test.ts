import { describe, expect, test } from "bun:test";
import { shouldTriggerPromptAutocomplete, textOffset, textPosition } from "./prompt-autocomplete.js";

describe("prompt autocomplete", () => {
    test("detects slash commands and @ file references", () => {
        expect(shouldTriggerPromptAutocomplete("/mod", 4)).toBe(true);
        expect(shouldTriggerPromptAutocomplete("review @src/ind", 15)).toBe(true);
        expect(shouldTriggerPromptAutocomplete('review @"docs/my f', 18)).toBe(true);
        expect(shouldTriggerPromptAutocomplete("ordinary prompt", 15)).toBe(false);
    });

    test("converts offsets to line positions and back", () => {
        const text = "first\nsecond\nthird";
        const position = textPosition(text, 10);
        expect(position).toEqual({ lines: ["first", "second", "third"], line: 1, column: 4 });
        expect(textOffset(position.lines, position.line, position.column)).toBe(10);
    });
});
