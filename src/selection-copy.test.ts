import { describe, expect, test } from "bun:test";
import { copyCurrentSelection, isCopyShortcut, type SelectionClipboard } from "./selection-copy.js";

describe("selection copying", () => {
  test("reading/highlighting a selection does not copy it", () => {
    let copies = 0;
    const renderer = {
      getSelection: () => ({ getSelectedText: () => "selected text" }),
      copyToClipboardOSC52: () => {
        copies += 1;
        return true;
      },
    } as unknown as SelectionClipboard;

    renderer.getSelection();
    expect(copies).toBe(0);
    expect(copyCurrentSelection(renderer)).toBe(true);
    expect(copies).toBe(1);
  });

  test("does not write an empty selection to the clipboard", () => {
    let copies = 0;
    const renderer = {
      getSelection: () => ({ getSelectedText: () => "" }),
      copyToClipboardOSC52: () => {
        copies += 1;
        return true;
      },
    } as unknown as SelectionClipboard;

    expect(copyCurrentSelection(renderer)).toBe(false);
    expect(copies).toBe(0);
  });

  test("recognizes Command-C without treating Alt-C as copy", () => {
    expect(isCopyShortcut({ name: "c", super: true })).toBe(true);
    expect(isCopyShortcut({ name: "C", super: true })).toBe(true);
    expect(isCopyShortcut({ name: "c", super: false })).toBe(false);
    expect(isCopyShortcut({ name: "x", super: true })).toBe(false);
  });
});
