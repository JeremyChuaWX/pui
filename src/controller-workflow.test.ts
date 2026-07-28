import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentSessionRuntime, createEventBus, type EventBusController } from "@earendil-works/pi-coding-agent";
import { PuiController } from "./controller.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
function run(sessionId: string, cwd: string, id = "run-1") {
    return {
        schema: "pi.workflow" as const,
        version: 1 as const,
        id,
        name: "Review",
        sessionId,
        cwd,
        status: "running" as const,
        phases: [],
        agents: [
            {
                id: "agent-1",
                label: "Agent",
                role: "explore",
                status: "running" as const,
                updatedAt: 1,
                usage,
                recentActivity: [],
            },
        ],
        usage,
        limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
        recentActivity: [],
        updatedAt: 1,
    };
}
const envelope = (sessionId: string, cwd: string, type: string, extra: object = {}) => ({
    schema: "pi.workflow.background",
    version: 1,
    sessionId,
    instanceId: "instance-1",
    cwd,
    type,
    ...extra,
});

function harness(cwd: string) {
    const bus = createEventBus();
    let sessionListener: (() => void) | undefined;
    let extensionBindings: any;
    const session: any = {
        messages: [],
        sessionId: "session-1",
        sessionName: undefined,
        model: undefined,
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        agent: { state: { streamingMessage: undefined, pendingToolCalls: new Set() } },
        getContextUsage: () => undefined,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
        bindExtensions: async (bindings: unknown) => {
            extensionBindings = bindings;
        },
        subscribe: () => () => {
            sessionListener = undefined;
        },
        extensionRunner: { getRegisteredCommands: () => [] },
        promptTemplates: [],
        settingsManager: { getEnableSkillCommands: () => false },
        resourceLoader: { getSkills: () => ({ skills: [] }) },
    };
    const runtime = {
        cwd,
        session,
        services: { modelRuntime: {} },
        setRebindSession: () => {},
        dispose: async () => {},
    } as unknown as AgentSessionRuntime;
    const Controller = PuiController as unknown as new (
        runtime: AgentSessionRuntime,
        bus: EventBusController,
    ) => PuiController;
    const controller = new Controller(runtime, bus);
    const bind = (next = session) => (controller as any).bindSession(next);
    return { bus, controller, runtime, session, bind, sessionListener, bindings: () => extensionBindings };
}

describe("PuiController workflow bridge", () => {
    test("binds authoritative snapshots, routes controls, and disposes cleanly", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-controller-"));
        const h = harness(temp);
        try {
            const canonical = fs.realpathSync(temp);
            h.session.bindExtensions = async () => {
                h.bus.emit("pui.workflow.background", envelope("session-1", canonical, "ready"));
                h.bus.emit(
                    "pui.workflow.background",
                    envelope("session-1", canonical, "upsert", { run: run("session-1", canonical) }),
                );
            };
            await h.bind();
            await Bun.sleep(25);
            expect(h.controller.listWorkflows().map((item) => item.id)).toEqual(["run-1"]);
            expect(h.controller.inspectWorkflow("run-1")?.name).toBe("Review");
            expect(h.controller.handlePrompt("/workflows")).toBe("workflows");

            const controls: unknown[] = [];
            h.bus.on("pui.workflow.background.control", (value) => controls.push(value));
            expect(h.controller.pauseWorkflow("run-1")).toBe(true);
            expect(h.controller.restartWorkflowAgent("run-1", "missing")).toBe(false);
            expect(h.controller.restartWorkflowAgent("run-1", "agent-1")).toBe(true);
            expect(controls).toEqual([
                expect.objectContaining({ action: "pause", runId: "run-1", cwd: canonical }),
                expect.objectContaining({ action: "restart-agent", runId: "run-1", agentId: "agent-1" }),
            ]);
            let saveRequest: any;
            h.bus.on("pui.workflow.background.save", (value: any) => {
                saveRequest = value;
                h.bus.emit("pui.workflow.background.save.result", {
                    schema: "pi.workflow.background.save.result",
                    version: 1,
                    sessionId: "session-1",
                    instanceId: "instance-1",
                    cwd: canonical,
                    requestId: value.requestId,
                    ok: true,
                    path: "/saved/review.js",
                });
            });
            expect(await h.controller.saveWorkflow("run-1", "project")).toBe("/saved/review.js");
            expect(saveRequest).toMatchObject({ runId: "run-1", scope: "project", overwrite: false });

            const prior = h.controller.snapshot();
            h.bus.emit("pui.workflow.background", envelope("wrong", canonical, "reset"));
            h.bus.emit("pui.workflow.background", envelope("session-1", `${canonical}/..`, "reset"));
            h.bus.emit("pui.workflow.background", { ...envelope("session-1", canonical, "reset"), version: 2 });
            expect(h.controller.snapshot()).toBe(prior);
            await h.controller.dispose();
            h.bus.emit(
                "pui.workflow.background",
                envelope("session-1", canonical, "upsert", { run: run("session-1", canonical, "late") }),
            );
            expect(h.controller.snapshot().workflows).toEqual([]);
        } finally {
            await h.controller.dispose();
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });

    test("bridges queued extension dialogs with resolve, deny, abort, timeout, rebind, and dispose", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-dialog-controller-"));
        const h = harness(temp);
        try {
            await h.bind();
            const ui = h.bindings().uiContext;
            const confirm = ui.confirm("Run?", "exact body");
            const select = ui.select("Trust?", ["once", "trust"]);
            expect(h.controller.snapshot().extensionDialog).toMatchObject({ kind: "confirm", message: "exact body" });
            const first = h.controller.snapshot().extensionDialog!;
            expect(h.controller.resolveExtensionDialog(first.id, true)).toBe(true);
            expect(await confirm).toBe(true);
            expect(h.controller.snapshot().extensionDialog).toMatchObject({
                kind: "select",
                options: ["once", "trust"],
            });
            const second = h.controller.snapshot().extensionDialog!;
            expect(h.controller.resolveExtensionDialog(second.id, "other")).toBe(true);
            expect(await select).toBeUndefined();
            expect(h.controller.resolveExtensionDialog(second.id, "once")).toBe(false);

            const invalidConfirm = ui.confirm("Confirm", "body");
            const invalidConfirmDialog = h.controller.snapshot().extensionDialog!;
            h.controller.resolveExtensionDialog(invalidConfirmDialog.id, "true");
            expect(await invalidConfirm).toBe(false);

            const abort = new AbortController();
            const input = ui.input("Value", "placeholder", { signal: abort.signal });
            abort.abort();
            expect(await input).toBeUndefined();
            expect(await ui.confirm("Timeout", "body", { timeout: 1 })).toBe(false);

            const raced = ui.confirm("Race", "body", { timeout: 1 });
            const racedDialog = h.controller.snapshot().extensionDialog!;
            await Bun.sleep(5);
            expect(await raced).toBe(false);
            expect(h.controller.resolveExtensionDialog(racedDialog.id, true)).toBe(false);

            const rebound = ui.confirm("Old", "body");
            await h.bind();
            expect(await rebound).toBe(false);
            const disposed = h.bindings().uiContext.input("Dispose");
            await h.controller.dispose();
            expect(await disposed).toBeUndefined();
        } finally {
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });

    test("bounds extension dialogs without truncating a 64 KiB approval body", async () => {
        const h = harness(process.cwd());
        await h.bind();
        const ui = h.bindings().uiContext;

        expect(await ui.confirm("x".repeat(513), "body")).toBe(false);
        expect(await ui.confirm("title", "x".repeat(64 * 1024 + 1))).toBe(false);
        expect(
            await ui.select(
                "title",
                Array.from({ length: 101 }, (_, index) => `${index}`),
            ),
        ).toBeUndefined();
        expect(await ui.select("title", ["x".repeat(4097)])).toBeUndefined();
        expect(await ui.input("title", "x".repeat(1025))).toBeUndefined();
        expect(h.controller.snapshot().extensionDialog).toBeUndefined();

        const exact = ui.confirm("title", "x".repeat(64 * 1024));
        const exactDialog = h.controller.snapshot().extensionDialog!;
        h.controller.resolveExtensionDialog(exactDialog.id, true);
        expect(await exact).toBe(true);

        const queued = Array.from({ length: 32 }, (_, index) => ui.input(`input ${index}`));
        expect(await ui.input("overflow")).toBeUndefined();
        for (let index = 0; index < queued.length; index += 1) {
            const dialog = h.controller.snapshot().extensionDialog!;
            h.controller.resolveExtensionDialog(dialog.id, `value ${index}`);
        }
        expect(await Promise.all(queued)).toHaveLength(32);
        await h.controller.dispose();
    });

    test("resets on replacement and accepts only the replacement instance", async () => {
        const h = harness(process.cwd());
        await h.bind();
        const cwd = fs.realpathSync(process.cwd());
        h.bus.emit("pui.workflow.background", envelope("session-1", cwd, "ready"));
        h.bus.emit("pui.workflow.background", envelope("session-1", cwd, "upsert", { run: run("session-1", cwd) }));
        h.bus.emit("pui.workflow.background", envelope("session-1", cwd, "reset"));
        h.bus.emit("pui.workflow.background", { ...envelope("session-1", cwd, "ready"), instanceId: "instance-2" });
        h.bus.emit("pui.workflow.background", {
            ...envelope("session-1", cwd, "upsert", { run: run("session-1", cwd, "new") }),
            instanceId: "instance-2",
        });
        h.bus.emit(
            "pui.workflow.background",
            envelope("session-1", cwd, "upsert", { run: run("session-1", cwd, "stale") }),
        );
        await Bun.sleep(25);
        expect(h.controller.listWorkflows().map((item) => item.id)).toEqual(["new"]);

        const replacement = { ...h.session, sessionId: "session-2" };
        (h.runtime as any).session = replacement;
        await h.bind(replacement);
        expect(h.controller.listWorkflows()).toEqual([]);
        expect(h.controller.stopWorkflow("new")).toBe(false);
        await h.controller.dispose();
    });
});
