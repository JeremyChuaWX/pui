import { describe, expect, test } from "bun:test";
import { isWorkflowBackShortcut, workflowBackKeyHint } from "./workflow-navigation.js";

describe("workflow navigation", () => {
    test("returns to chat with escape or Ctrl+C", () => {
        expect(isWorkflowBackShortcut({ name: "escape", ctrl: false })).toBe(true);
        expect(isWorkflowBackShortcut({ name: "c", ctrl: true })).toBe(true);
        expect(isWorkflowBackShortcut({ name: "C", ctrl: true })).toBe(true);
    });

    test("does not consume unrelated keys", () => {
        expect(isWorkflowBackShortcut({ name: "c", ctrl: false })).toBe(false);
        expect(isWorkflowBackShortcut({ name: "pageup", ctrl: false })).toBe(false);
        expect(workflowBackKeyHint).toBe("Esc/Ctrl+C");
    });
});
