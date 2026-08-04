import { describe, expect, test } from "bun:test";
import {
    canNavigatePromptHistory,
    cycleIndex,
    dismissKeyHint,
    extensionConfirmKeyHint,
    extensionConfirmKeyIntent,
    isDismissKey,
    promptHistoryDirection,
} from "./keys.js";

describe("list cycling", () => {
    test("cycles forward and backward at list boundaries", () => {
        expect(cycleIndex(2, 1, 3)).toBe(0);
        expect(cycleIndex(0, -1, 3)).toBe(2);
    });

    test("moves within the list", () => {
        expect(cycleIndex(1, 1, 3)).toBe(2);
        expect(cycleIndex(1, -1, 3)).toBe(0);
    });

    test("stays at zero for an empty list", () => {
        expect(cycleIndex(0, 1, 0)).toBe(0);
        expect(cycleIndex(0, -1, 0)).toBe(0);
    });
});

describe("dismiss shortcut", () => {
    test("dismisses with escape or Ctrl+C", () => {
        expect(isDismissKey({ name: "escape", ctrl: false })).toBe(true);
        expect(isDismissKey({ name: "c", ctrl: true })).toBe(true);
        expect(isDismissKey({ name: "C", ctrl: true })).toBe(true);
    });

    test("does not consume unrelated keys", () => {
        expect(isDismissKey({ name: "c", ctrl: false })).toBe(false);
        expect(isDismissKey({ name: "pageup", ctrl: false })).toBe(false);
        expect(dismissKeyHint).toBe("Esc/Ctrl+C");
    });
});

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

describe("extension confirm keyboard intent", () => {
    test.each(["return", "enter", "linefeed", "y"])("approves with bare %s", (name) => {
        expect(extensionConfirmKeyIntent({ name })).toBe("approve");
    });

    test("allows shift only for Y/N", () => {
        expect(extensionConfirmKeyIntent({ name: "y", shift: true })).toBe("approve");
        expect(extensionConfirmKeyIntent({ name: "n", shift: true })).toBe("deny");
        expect(extensionConfirmKeyIntent({ name: "return", shift: true })).toBe("suppress");
        expect(extensionConfirmKeyIntent({ name: "pageup", shift: true })).toBe("suppress");
    });

    test("denies with bare escape or N, and Ctrl+C", () => {
        expect(extensionConfirmKeyIntent({ name: "escape" })).toBe("deny");
        expect(extensionConfirmKeyIntent({ name: "n" })).toBe("deny");
        expect(extensionConfirmKeyIntent({ name: "c", ctrl: true })).toBe("deny");
    });

    test("preserves bare transcript paging", () => {
        expect(extensionConfirmKeyIntent({ name: "pageup" })).toBe("page-up");
        expect(extensionConfirmKeyIntent({ name: "pagedown" })).toBe("page-down");
    });

    test("derives the displayed hint from the supported shortcuts", () => {
        expect(extensionConfirmKeyHint).toBe("Enter/Y approve · Esc/N/Ctrl+C deny · PageUp/PageDown scroll");
    });

    test.each([
        { name: "y", ctrl: true },
        { name: "n", meta: true },
        { name: "enter", option: true },
        { name: "pagedown", ctrl: true },
        { name: "c", ctrl: true, shift: true },
        { name: "escape", meta: true },
        { name: "k", ctrl: true },
        { name: "a" },
    ])("suppresses modified or unrelated key $name", (key) => {
        expect(extensionConfirmKeyIntent(key)).toBe("suppress");
    });
});
