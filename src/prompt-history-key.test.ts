import { describe, expect, test } from "bun:test";
import { canNavigatePromptHistory, promptHistoryDirection } from "./prompt-history-key.js";

describe("promptHistoryDirection", () => {
    test.each([
        [{ name: "up" }, "previous"],
        [{ name: "p", ctrl: true }, "previous"],
        [{ name: "down" }, "next"],
        [{ name: "n", ctrl: true }, "next"],
    ] as const)("maps %o to %s", (key, direction) => {
        expect(promptHistoryDirection(key)).toBe(direction);
    });

    test.each([
        { name: "p" },
        { name: "n" },
        { name: "left" },
        { name: "up", shift: true },
        { name: "up", meta: true },
        { name: "down", option: true },
        { name: "down", ctrl: true },
        { name: "p", ctrl: true, shift: true },
        { name: "p", ctrl: true, meta: true },
        { name: "n", ctrl: true, option: true },
    ])("ignores %o", (key) => {
        expect(promptHistoryDirection(key)).toBeUndefined();
    });
});

describe("canNavigatePromptHistory", () => {
    const prompt = (plainText: string, cursorOffset: number) => ({
        plainText,
        cursorOffset,
        focused: true,
        isDestroyed: false,
    });

    test("allows navigation only at the corresponding multiline boundary", () => {
        expect(canNavigatePromptHistory(prompt("first\nsecond", 2), "previous")).toBe(true);
        expect(canNavigatePromptHistory(prompt("first\nsecond", 2), "next")).toBe(false);
        expect(canNavigatePromptHistory(prompt("first\nsecond", 8), "previous")).toBe(false);
        expect(canNavigatePromptHistory(prompt("first\nsecond", 8), "next")).toBe(true);
    });

    test("rejects missing, destroyed, and unfocused prompts", () => {
        expect(canNavigatePromptHistory(undefined, "previous")).toBe(false);
        expect(canNavigatePromptHistory({ ...prompt("", 0), isDestroyed: true }, "previous")).toBe(false);
        expect(canNavigatePromptHistory({ ...prompt("", 0), focused: false }, "next")).toBe(false);
    });
});
