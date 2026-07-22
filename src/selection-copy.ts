import type { KeyEvent, Selection } from "@opentui/core";

export interface SelectionClipboard {
  getSelection(): Selection | null;
  copyToClipboardOSC52(text: string): boolean;
}

/** Copy the current OpenTUI selection, but only when called by an explicit shortcut. */
export function copyCurrentSelection(renderer: SelectionClipboard): boolean {
  const text = renderer.getSelection()?.getSelectedText() ?? "";
  return text.length > 0 && renderer.copyToClipboardOSC52(text);
}

export function isCopyShortcut(key: Pick<KeyEvent, "name" | "super">): boolean {
  return key.name.toLowerCase() === "c" && key.super === true;
}
