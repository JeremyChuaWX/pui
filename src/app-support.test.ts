import { describe, expect, test } from "bun:test";
import {
    buildEditorBuffer,
    copyCurrentSelection,
    extractEditedPrompt,
    type FocusTrapTarget,
    isCopyShortcut,
    PromptHistory,
    REFERENCE_INSTRUCTION,
    REFERENCE_MARKER,
    type SelectionSource,
    trapFocus,
} from "./app-support.js";

class Target implements FocusTrapTarget {
    isDestroyed = false;
    focusCount = 0;
    listener?: () => void;
    focus() {
        this.focusCount += 1;
    }
    on(_event: "blurred", listener: () => void) {
        this.listener = listener;
    }
    off(_event: "blurred", listener: () => void) {
        if (this.listener === listener) this.listener = undefined;
    }
}

describe("focus trap", () => {
    test("restores focus after blur while enabled", () => {
        const target = new Target();
        const queued: Array<() => void> = [];
        trapFocus(
            target,
            () => true,
            (callback) => queued.push(callback),
        );

        target.listener?.();
        expect(target.focusCount).toBe(0);
        queued[0]?.();
        expect(target.focusCount).toBe(1);
    });

    test("allows intentional blur and can be disposed", () => {
        const target = new Target();
        const queued: Array<() => void> = [];
        let enabled = true;
        const dispose = trapFocus(
            target,
            () => enabled,
            (callback) => queued.push(callback),
        );

        target.listener?.();
        enabled = false;
        queued.shift()?.();
        expect(target.focusCount).toBe(0);

        enabled = true;
        target.listener?.();
        dispose();
        queued.shift()?.();
        expect(target.focusCount).toBe(0);
        expect(target.listener).toBeUndefined();
    });
});

describe("selection copying", () => {
    test("reading/highlighting a selection does not copy it", async () => {
        let copiedText = "";
        const source = {
            getSelection: () => ({ getSelectedText: () => "selected text" }),
        } as unknown as SelectionSource;
        const writeClipboard = (text: string) => {
            copiedText = text;
        };

        source.getSelection();
        expect(copiedText).toBe("");
        expect(await copyCurrentSelection(source, writeClipboard)).toBe(true);
        expect(copiedText).toBe("selected text");
    });

    test("does not write an empty selection to the clipboard", async () => {
        let copies = 0;
        const source = {
            getSelection: () => ({ getSelectedText: () => "" }),
        } as unknown as SelectionSource;

        expect(
            await copyCurrentSelection(source, () => {
                copies += 1;
            }),
        ).toBe(false);
        expect(copies).toBe(0);
    });

    test("recognizes Ctrl-Shift-C", () => {
        const commandC = { name: "c", ctrl: false, shift: false, super: true };

        expect(isCopyShortcut({ name: "c", ctrl: true, shift: true })).toBe(true);
        expect(isCopyShortcut({ name: "C", ctrl: true, shift: true })).toBe(true);
        expect(isCopyShortcut(commandC)).toBe(false);
        expect(isCopyShortcut({ name: "c", ctrl: false, shift: true })).toBe(false);
        expect(isCopyShortcut({ name: "x", ctrl: true, shift: true })).toBe(false);
    });

    test("treats ambiguous Ctrl-C as copy only while text is selected", () => {
        const ctrlC = { name: "c", ctrl: true, shift: false };

        expect(isCopyShortcut(ctrlC)).toBe(false);
        expect(isCopyShortcut(ctrlC, true)).toBe(true);
        expect(isCopyShortcut({ name: "x", ctrl: true, shift: false }, true)).toBe(false);
    });
});

describe("external editor buffer", () => {
    test("places the last assistant response above an ignored reference block", () => {
        expect(buildEditorBuffer("Last response\n", "my draft")).toBe(
            `Last response\n\n${REFERENCE_MARKER}\n${REFERENCE_INSTRUCTION}\n\nmy draft`,
        );
    });

    test("leaves a draft alone when there is no assistant response", () => {
        expect(buildEditorBuffer("", "my draft")).toBe("my draft");
    });

    test("returns only text below the reference marker", () => {
        const buffer = buildEditorBuffer("reference", "edited prompt\nwith detail\n");
        expect(extractEditedPrompt(buffer)).toBe("edited prompt\nwith detail");
    });

    test("normalizes Windows newlines in a reference buffer", () => {
        const buffer = `reference\r\n\r\n${REFERENCE_MARKER}\r\n${REFERENCE_INSTRUCTION}\r\n\r\nnew prompt\r\n`;
        expect(extractEditedPrompt(buffer)).toBe("new prompt");
    });

    test("normalizes Windows newlines in a marker-free buffer", () => {
        expect(extractEditedPrompt("edited prompt\r\nwith detail\r\n")).toBe("edited prompt\nwith detail");
    });
});

describe("PromptHistory", () => {
    test("navigates from newest to oldest and back to the draft", () => {
        const history = new PromptHistory();
        history.add("first prompt");
        history.add("second prompt");

        expect(history.previous("unfinished draft")).toBe("second prompt");
        expect(history.previous("second prompt")).toBe("first prompt");
        expect(history.previous("first prompt")).toBeUndefined();
        expect(history.next()).toBe("second prompt");
        expect(history.next()).toBe("unfinished draft");
        expect(history.next()).toBeUndefined();
    });

    test("trims entries, ignores blanks and consecutive duplicates", () => {
        const history = new PromptHistory();
        history.add("  repeated prompt  ");
        history.add("repeated prompt");
        history.add("   ");

        expect(history.previous("")).toBe("repeated prompt");
        expect(history.previous("repeated prompt")).toBeUndefined();
    });

    test("limits retained entries", () => {
        const history = new PromptHistory(2);
        history.add("first");
        history.add("second");
        history.add("third");

        expect(history.previous("")).toBe("third");
        expect(history.previous("third")).toBe("second");
        expect(history.previous("second")).toBeUndefined();
    });

    test("retains commands alongside regular prompts", () => {
        const history = new PromptHistory();
        history.add("regular prompt");
        history.add("/model provider/model");

        expect(history.previous("")).toBe("/model provider/model");
        expect(history.previous("/model provider/model")).toBe("regular prompt");
    });

    test("tracks traversal until returning to the draft or being reset", () => {
        const emptyHistory = new PromptHistory();
        expect(emptyHistory.isTraversing).toBe(false);
        expect(emptyHistory.previous("draft")).toBeUndefined();
        expect(emptyHistory.isTraversing).toBe(false);

        const history = new PromptHistory();
        history.add("first");
        expect(history.isTraversing).toBe(false);

        expect(history.previous("draft")).toBe("first");
        expect(history.isTraversing).toBe(true);
        expect(history.next()).toBe("draft");
        expect(history.isTraversing).toBe(false);

        expect(history.previous("another draft")).toBe("first");
        history.resetBrowsing();
        expect(history.isTraversing).toBe(false);

        expect(history.previous("final draft")).toBe("first");
        history.add("second");
        expect(history.isTraversing).toBe(false);
    });

    test("starts a fresh traversal after browsing is reset", () => {
        const history = new PromptHistory();
        history.add("first");
        history.add("second");

        expect(history.previous("old draft")).toBe("second");
        history.resetBrowsing();
        expect(history.previous("new draft")).toBe("second");
        expect(history.next()).toBe("new draft");
    });
});
