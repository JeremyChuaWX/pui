import type { KeyEvent } from "@opentui/core";

export const workflowBackKeyHint = "Esc/Ctrl+C";

/** Return shortcuts for the read-only workflow status page. */
export function isWorkflowBackShortcut(key: Pick<KeyEvent, "name" | "ctrl">): boolean {
    return key.name.toLowerCase() === "escape" || (key.ctrl && key.name.toLowerCase() === "c");
}
