import { describe, expect, test } from "bun:test";
import {
    canNavigatePromptHistory,
    cycleIndex,
    dismissKeyHint,
    extensionConfirmKeyHint,
    extensionConfirmKeyIntent,
    globalKeyHelp,
    globalKeyIntent,
    isDismissKey,
    listNavigationDirection,
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

describe("listNavigationDirection", () => {
    test.each([
        [{ name: "up" }, -1],
        [{ name: "p", ctrl: true }, -1],
        [{ name: "down" }, 1],
        [{ name: "n", ctrl: true }, 1],
        [{ name: "p", ctrl: true, shift: true }, -1],
    ] as const)("maps %o to %i", (key, direction) => {
        expect(listNavigationDirection(key)).toBe(direction);
    });

    test.each([{ name: "p" }, { name: "n" }, { name: "left" }, { name: "escape" }])("ignores %o", (key) => {
        expect(listNavigationDirection(key)).toBeUndefined();
    });
});

describe("global key intents", () => {
    test.each([
        [{ name: "return", option: true }, "queue-follow-up"],
        [{ name: "enter", meta: true }, "queue-follow-up"],
        [{ name: "linefeed", option: true }, "queue-follow-up"],
        [{ name: "g", ctrl: true }, "external-editor"],
        [{ name: "escape" }, "abort"],
        [{ name: "tab", shift: true }, "cycle-thinking"],
        [{ name: "n", option: true }, "cycle-model-forward"],
        [{ name: "p", meta: true }, "cycle-model-backward"],
        [{ name: "l", ctrl: true }, "open-models"],
        [{ name: "r", ctrl: true }, "open-sessions"],
        [{ name: "k", ctrl: true }, "open-commands"],
        [{ name: "o", ctrl: true }, "toggle-tool-details"],
        [{ name: "t", ctrl: true }, "toggle-thinking-details"],
        [{ name: "b", ctrl: true }, "toggle-sidebar"],
        [{ name: "pageup" }, "page-up"],
        [{ name: "pagedown" }, "page-down"],
        [{ name: "c", ctrl: true }, "interrupt"],
        [{ name: "d", ctrl: true }, "quit"],
    ] as const)("maps %o to %s", (key, intent) => {
        expect(globalKeyIntent(key)).toBe(intent);
    });

    test("ignores unspecified modifiers, matching the historical if-chain", () => {
        expect(globalKeyIntent({ name: "l", ctrl: true, shift: true })).toBe("open-models");
        expect(globalKeyIntent({ name: "p", ctrl: true, option: true })).toBe("cycle-model-backward");
        expect(globalKeyIntent({ name: "pageup", ctrl: true })).toBe("page-up");
        expect(globalKeyIntent({ name: "escape", ctrl: true })).toBe("abort");
        expect(globalKeyIntent({ name: "c", ctrl: true, shift: true })).toBe("interrupt");
    });

    test.each([
        { name: "l" },
        { name: "tab" },
        { name: "c" },
        { name: "n", ctrl: true },
        { name: "p", ctrl: true },
        { name: "return" },
        { name: "return", shift: true },
        { name: "a" },
    ])("does not consume %o", (key) => {
        expect(globalKeyIntent(key)).toBeUndefined();
    });

    test("derives the Help shortcut list from the same table", () => {
        expect(globalKeyHelp.map(({ label, description }) => `${label} ${description}`)).toEqual([
            "Enter send / steer while working",
            "Shift+Enter insert a new line",
            "Alt+Enter queue a follow-up",
            "Up / Down or Ctrl+P / Ctrl+N prompt history",
            "Ctrl+G edit in nvim with last agent response",
            "Escape abort the current operation",
            "Esc/Ctrl+C return from workflow status",
            "Shift+Tab cycle thinking level",
            "Alt+N / Alt+P cycle models",
            "Ctrl+L model picker",
            "Ctrl+R session picker",
            "Ctrl+K command palette",
            "Ctrl+O tool output",
            "Ctrl+T reasoning blocks",
            "Ctrl+B sidebar",
            "PageUp/Down scroll transcript",
            "Ctrl+Shift+C copy highlighted text",
            "Ctrl+C/D abort, clear, or quit",
        ]);
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
