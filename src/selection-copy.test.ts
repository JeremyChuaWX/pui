import { describe, expect, test } from "bun:test";
import { copyCurrentSelection, isCopyShortcut, type SelectionSource } from "./selection-copy.js";

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
