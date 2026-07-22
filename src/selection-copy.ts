import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { KeyEvent, Selection } from "@opentui/core";

export interface SelectionSource {
  getSelection(): Selection | null;
}

type ClipboardWriter = (text: string) => void | Promise<void>;

/** Copy the current OpenTUI selection through the native clipboard with OSC 52 fallback. */
export async function copyCurrentSelection(
  source: SelectionSource,
  writeClipboard: ClipboardWriter = copyToClipboard,
): Promise<boolean> {
  const text = source.getSelection()?.getSelectedText() ?? "";
  if (text.length === 0) return false;
  await writeClipboard(text);
  return true;
}

/**
 * Treat Ctrl-C as copy while text is highlighted because legacy terminal paths,
 * including tmux without extended-key forwarding, cannot preserve Shift.
 */
export function isCopyShortcut(
  key: Pick<KeyEvent, "name" | "ctrl" | "shift">,
  hasSelection = false,
): boolean {
  return key.name.toLowerCase() === "c" && key.ctrl && (key.shift || hasSelection);
}
