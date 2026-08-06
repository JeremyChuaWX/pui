import { describe, expect, test } from "bun:test";
import type { PuiSnapshot } from "../types.js";
import type { DialogState, PickerItem } from "./dialogs.js";
import { createMenus, type MenuController, type MenuHost } from "./menus.js";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0.5, turns: 1 };

function workflowRun(status: "running" | "paused" | "failed" = "running") {
    return {
        schema: "pi.workflow" as const,
        version: 1 as const,
        id: "run-1",
        name: "Review",
        sessionId: "session-1",
        cwd: "/repo",
        status,
        phases: [{ id: "phase-1", name: "Plan", status, agentIds: ["agent-1"], updatedAt: 1 }],
        agents: [
            {
                id: "agent-1",
                label: "Reviewer",
                role: "explore",
                status,
                updatedAt: 1,
                usage,
                recentActivity: [],
            },
        ],
        usage,
        limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 1000, maxTokens: 0, maxCost: 0 },
        recentActivity: [],
        updatedAt: 1,
    };
}

interface Harness {
    menus: ReturnType<typeof createMenus>;
    dialogs: (DialogState | undefined)[];
    notifications: Array<[string, string | undefined]>;
    controls: Array<[string, string, string | undefined]>;
    controller: MenuController;
}

function createHarness(
    overrides: Partial<PuiSnapshot> = {},
    controlResult: Promise<string | undefined> = Promise.resolve(undefined),
): Harness {
    const dialogs: (DialogState | undefined)[] = [];
    const notifications: Array<[string, string | undefined]> = [];
    const controls: Array<[string, string, string | undefined]> = [];
    const snapshot = {
        workflows: [workflowRun()],
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
        inspectWorkflow: (runId) => snapshot.workflows.find((run) => run.id === runId),
        controlWorkflow: (runId, action, agentId) => {
            controls.push([runId, action, agentId]);
            return controlResult;
        },
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
    return { menus: createMenus(host), dialogs, notifications, controls, controller };
}

function lastPicker(harness: Harness): Extract<DialogState, { kind: "picker" }> {
    const dialog = harness.dialogs.at(-1);
    if (dialog?.kind !== "picker") throw new Error("expected a picker dialog");
    return dialog;
}

function item(picker: Extract<DialogState, { kind: "picker" }>, label: string): PickerItem {
    const found = picker.items.find((candidate) => candidate.label.includes(label));
    if (!found) throw new Error(`missing picker item: ${label}`);
    return found;
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
            "Workflows",
            "New session",
            "Compact context",
            "Thinking level",
            "Tool details",
            "Edit in nvim",
            "Help",
            "Quit",
        ]);
    });

    test("workflow list opens a run with phase, agent, and control items", () => {
        const harness = createHarness();
        harness.menus.openWorkflows();
        item(lastPicker(harness), "Review").action();
        const runPicker = lastPicker(harness);
        expect(runPicker.title).toBe("Workflow · Review");
        expect(runPicker.items.some(({ label }) => label === "Pause")).toBe(true);
        expect(runPicker.items.some(({ label }) => label === "Stop")).toBe(true);
        expect(runPicker.items.some(({ label }) => label === "Retry run")).toBe(false);

        item(runPicker, "Plan").action();
        expect(lastPicker(harness).title).toBe("Phase · Plan");
        item(lastPicker(harness), "Reviewer").action();
        expect(lastPicker(harness).title).toContain("Reviewer");
    });

    test("pause control routes through the controller and reports success", async () => {
        const harness = createHarness();
        harness.menus.openWorkflowRun("run-1");
        item(lastPicker(harness), "Pause").action();
        await Bun.sleep(0);
        expect(harness.controls).toEqual([["run-1", "pause", undefined]]);
        expect(harness.notifications).toEqual([["Workflow paused.", "success"]]);
    });

    test("destructive controls require confirmation before dispatch", async () => {
        const harness = createHarness();
        harness.menus.openWorkflowRun("run-1");
        item(lastPicker(harness), "Stop").action();
        const confirm = harness.dialogs.at(-1);
        if (confirm?.kind !== "confirm") throw new Error("expected a confirm dialog");
        expect(harness.controls).toEqual([]);
        confirm.action();
        await Bun.sleep(0);
        expect(harness.controls).toEqual([["run-1", "stop", undefined]]);
        expect(harness.notifications).toEqual([["Workflow control completed.", "success"]]);
    });

    test("retry appears for terminal runs and surfaces control failures", async () => {
        const failure = Promise.reject(new Error("backend unavailable"));
        failure.catch(() => {});
        const harness = createHarness({ workflows: [workflowRun("failed")] } as Partial<PuiSnapshot>, failure);
        harness.menus.openWorkflowRun("run-1");
        const picker = lastPicker(harness);
        expect(picker.items.some(({ label }) => label === "Pause")).toBe(false);
        item(picker, "Retry run").action();
        const confirm = harness.dialogs.at(-1);
        if (confirm?.kind !== "confirm") throw new Error("expected a confirm dialog");
        confirm.action();
        await Bun.sleep(0);
        expect(harness.controls).toEqual([["run-1", "retry", undefined]]);
        expect(harness.notifications).toEqual([["backend unavailable", "error"]]);
    });

    test("reports missing workflows instead of opening a picker", () => {
        const harness = createHarness({ workflows: [] } as Partial<PuiSnapshot>);
        harness.menus.openWorkflowRun("gone");
        expect(harness.dialogs).toEqual([]);
        expect(harness.notifications).toEqual([["Workflow is no longer available.", "error"]]);
    });
});
