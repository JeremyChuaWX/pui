import { describe, expect, test } from "bun:test";
import type { PuiSnapshot } from "../state/types.js";
import type { DialogState } from "./dialogs.js";
import { createMenus, type MenuController, type MenuHost } from "./menus.js";

interface Harness {
    menus: ReturnType<typeof createMenus>;
    dialogs: (DialogState | undefined)[];
    notifications: Array<[string, string | undefined]>;
    controller: MenuController;
}

function createHarness(overrides: Partial<PuiSnapshot> = {}): Harness {
    const dialogs: (DialogState | undefined)[] = [];
    const notifications: Array<[string, string | undefined]> = [];
    const snapshot = {
        backgroundSubagents: [],
        ...overrides,
    } as unknown as PuiSnapshot;
    const controller: MenuController = {
        listModels: async () => [],
        selectModel: async () => {},
        listSessions: async () => [],
        switchSession: async () => {},
        notify: (message, type) => notifications.push([message, type]),
        snapshot: () => snapshot,
        cancelBackgroundSubagent: () => false,
        newSession: async () => {},
        compact: async () => {},
        cycleThinking: () => {},
        requestExit: () => {},
    };
    const host: MenuHost = {
        controller,
        snapshot: () => snapshot,
        openDialog: (dialog) => dialogs.push(dialog),
        closeDialog: () => dialogs.push(undefined),
        openAsyncPicker: async (title, placeholder, load) =>
            void dialogs.push({ kind: "picker", title, placeholder, items: await load() }),
        closeCompletions: () => {},
        toggleToolDetails: () => {},
        openExternalEditor: () => {},
    };
    return { menus: createMenus(host), dialogs, notifications, controller };
}

function lastPicker(harness: Harness): Extract<DialogState, { kind: "picker" }> {
    const dialog = harness.dialogs.at(-1);
    if (dialog?.kind !== "picker") throw new Error("expected a picker dialog");
    return dialog;
}

describe("menus", () => {
    test("command palette lists every command", () => {
        const harness = createHarness();
        harness.menus.openCommands();
        const picker = lastPicker(harness);
        expect(picker.title).toBe("Commands");
        expect(picker.items.map(({ label }) => label)).toEqual([
            "Models",
            "Sessions",
            "Subagents",
            "New session",
            "Compact context",
            "Thinking level",
            "Tool details",
            "Edit in nvim",
            "Help",
            "Quit",
        ]);
    });
});
