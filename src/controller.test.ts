import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentSessionEvent, type AgentSessionRuntime, createEventBus } from "@earendil-works/pi-coding-agent";
import { waitFor } from "../extensions/test-support/wait.js";
import { PuiController } from "./controller.js";

function usage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function details(id: string, status: "queued" | "running" | "succeeded" | "failed") {
    const terminal = status === "succeeded" || status === "failed";
    return {
        schema: "pi.subagent",
        version: 1,
        run: {
            id,
            agent: "explore",
            model: "fixture/model",
            cwd: process.cwd(),
            status,
            phase: status === "queued" ? "queued" : terminal ? "exiting" : "thinking",
            ...(status === "queued" ? {} : { startedAt: 10 }),
            updatedAt: 20,
            ...(terminal ? { endedAt: 30 } : {}),
            activeTools: [],
            recentActivity: [],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 },
            ...(status === "failed" ? { error: "fixture failure" } : {}),
        },
    };
}

function assistantText(text: string): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        usage: usage(),
        stopReason: "stop",
        timestamp: 1,
    } as AgentMessage;
}

function assistantCalls(ids: string[]): AgentMessage {
    return {
        role: "assistant",
        content: ids.map((id) => ({
            type: "toolCall" as const,
            id,
            name: "delegator",
            arguments: { agent: "explore", prompt: `Inspect ${id}`, cwd: process.cwd() },
        })),
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        usage: usage(),
        stopReason: "toolUse",
        timestamp: 1,
    } as AgentMessage;
}

interface FakeSessionState {
    messages: AgentMessage[];
    pending: Set<string>;
    isStreaming: boolean;
}

async function createController(
    messages: AgentMessage[],
    eventBus?: ReturnType<typeof createEventBus>,
): Promise<{
    controller: PuiController;
    state: FakeSessionState;
    emit: (event: AgentSessionEvent) => void;
}> {
    const state: FakeSessionState = { messages, pending: new Set(), isStreaming: true };
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
        get messages() {
            return state.messages;
        },
        agent: {
            state: {
                get streamingMessage() {
                    return undefined;
                },
                get pendingToolCalls() {
                    return state.pending;
                },
            },
        },
        getContextUsage: () => undefined,
        sessionId: "fixture-session",
        sessionName: undefined,
        model: { id: "fixture-model", provider: "fixture" },
        thinkingLevel: "off",
        get isStreaming() {
            return state.isStreaming;
        },
        isCompacting: false,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
        bindExtensions: async () => {},
        subscribe: (next: (event: AgentSessionEvent) => void) => {
            listener = next;
            return () => {
                listener = undefined;
            };
        },
        extensionRunner: { getRegisteredCommands: () => [] },
        promptTemplates: [],
        settingsManager: { getEnableSkillCommands: () => false },
        resourceLoader: { getSkills: () => ({ skills: [] }) },
    };
    const runtime = {
        cwd: process.cwd(),
        session,
        setRebindSession: () => {},
        dispose: async () => {},
    } as unknown as AgentSessionRuntime;
    const controller = new PuiController(runtime, eventBus ? { eventBus } : {});
    await controller.bindSession(runtime.session);
    const emit = (event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") state.pending.add(event.toolCallId);
        if (event.type === "tool_execution_end") state.pending.delete(event.toolCallId);
        listener?.(event);
    };
    return { controller, state, emit };
}

describe("PuiController background event bridge", () => {
    test("coalesces current-instance updates and clears the bus on disposal", async () => {
        const bus = createEventBus();
        const { controller } = await createController([], bus);
        let notifications = 0;
        controller.subscribe(() => notifications++);
        const envelope = (type: string, status = "running") => ({
            schema: "pi.subagent.background",
            version: 1,
            sessionId: "fixture-session",
            instanceId: "live-instance",
            type,
            ...(type === "upsert"
                ? { job: { id: "job", title: "Background", run: details("job", status as any).run } }
                : {}),
        });
        bus.emit("pui.subagent.background", envelope("ready"));
        bus.emit("pui.subagent.background", envelope("upsert", "queued"));
        bus.emit("pui.subagent.background", envelope("upsert", "running"));
        expect(notifications).toBe(1);
        await Bun.sleep(25);
        expect(notifications).toBe(2);
        expect(controller.snapshot().backgroundSubagents).toEqual([
            expect.objectContaining({ id: "job", title: "Background", status: "running" }),
        ]);
        let control: unknown;
        const unsubscribeControl = bus.on("pui.subagent.background.control", (payload) => (control = payload));
        expect(controller.cancelBackgroundSubagent("job")).toBe(true);
        expect(control).toEqual({
            schema: "pi.subagent.background.control",
            version: 1,
            sessionId: "fixture-session",
            instanceId: "live-instance",
            type: "cancel",
            jobId: "job",
        });
        expect(controller.cancelBackgroundSubagent("missing")).toBe(false);
        for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) {
            bus.emit("pui.subagent.background", envelope("upsert", status));
            expect(controller.cancelBackgroundSubagent("job")).toBe(false);
        }
        unsubscribeControl();
        await controller.dispose();
        bus.emit("pui.subagent.background", envelope("upsert", "succeeded"));
        expect(controller.snapshot().backgroundSubagents).toEqual([]);
    });
});

describe("PuiController assistant reference text", () => {
    test("returns only text blocks from the last assistant message with text", async () => {
        const mixed = assistantText("unused");
        if (mixed.role !== "assistant") throw new Error("Expected assistant fixture");
        mixed.content = [
            { type: "text", text: "First" },
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
            { type: "text", text: "Second\n\n" },
        ];
        const { controller } = await createController([
            assistantText("Older"),
            mixed,
            assistantCalls(["latest-tool-only"]),
        ]);

        expect(controller.getLastAssistantText()).toBe("First\nSecond");
        await controller.dispose();
    });
});

describe("PuiController tool event path", () => {
    test("transports partial subagent snapshots and preserves a running sibling", async () => {
        const ids = ["slow", "fast"];
        const { controller, state, emit } = await createController([
            assistantText("Stable context"),
            assistantCalls(ids),
        ]);

        for (const id of ids) {
            const args = { agent: "explore", prompt: `Inspect ${id}`, cwd: process.cwd() };
            emit({ type: "tool_execution_start", toolCallId: id, toolName: "delegator", args });
            emit({
                type: "tool_execution_update",
                toolCallId: id,
                toolName: "delegator",
                args,
                partialResult: { content: [{ type: "text", text: "queued" }], details: details(id, "queued") },
            });
        }
        await Bun.sleep(25);

        let snapshot = controller.snapshot();
        const textItem = snapshot.display.find((item) => item.kind === "assistant");
        const queuedSlow = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow");
        const queuedFast = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast");
        expect(textItem).toBeDefined();
        expect(queuedSlow).toBeDefined();
        expect(queuedFast).toBeDefined();
        expect(snapshot.activeTools.map((tool) => tool.id).sort()).toEqual([...ids].sort());
        expect(
            snapshot.display
                .filter((item) => item.kind === "tool")
                .map((item) => [item.toolCallId, item.subagent?.status]),
        ).toEqual([
            ["slow", "queued"],
            ["fast", "queued"],
        ]);

        const slowArgs = { agent: "explore", prompt: "Inspect slow", cwd: process.cwd() };
        emit({
            type: "tool_execution_update",
            toolCallId: "slow",
            toolName: "delegator",
            args: slowArgs,
            partialResult: { content: [{ type: "text", text: "working" }], details: details("slow", "running") },
        });
        await Bun.sleep(25);
        snapshot = controller.snapshot();
        const runningSlow = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow");
        expect(snapshot.display.find((item) => item.kind === "assistant")).toBe(textItem);
        expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast")).toBe(queuedFast);
        expect(runningSlow).not.toBe(queuedSlow);
        expect(runningSlow).toEqual(
            expect.objectContaining({ running: true, subagent: expect.objectContaining({ status: "running" }) }),
        );

        emit({
            type: "tool_execution_end",
            toolCallId: "fast",
            toolName: "delegator",
            result: {
                content: [{ type: "text", text: "fixture failure" }],
                details: details("fast", "failed"),
            },
            isError: true,
        });
        snapshot = controller.snapshot();
        expect(snapshot.activeTools.map((tool) => tool.id)).toEqual(["slow"]);
        expect(snapshot.display.find((item) => item.kind === "assistant")).toBe(textItem);
        expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow")).toBe(runningSlow);
        const failedFast = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast");
        expect(failedFast).not.toBe(queuedFast);
        expect(failedFast).toEqual(
            expect.objectContaining({
                running: false,
                isError: true,
                subagent: expect.objectContaining({ status: "failed" }),
            }),
        );

        state.messages.push({
            role: "toolResult",
            toolCallId: "fast",
            toolName: "delegator",
            content: [{ type: "text", text: "fixture failure" }],
            details: details("fast", "failed"),
            isError: true,
            timestamp: 2,
        } as AgentMessage);
        emit({
            type: "tool_execution_end",
            toolCallId: "slow",
            toolName: "delegator",
            result: { content: [{ type: "text", text: "done" }], details: details("slow", "succeeded") },
            isError: false,
        });
        snapshot = controller.snapshot();
        expect(snapshot.activeTools).toEqual([]);
        expect(snapshot.display.find((item) => item.kind === "assistant")).toBe(textItem);
        expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast")).toBe(failedFast);
        const succeededSlow = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow");
        expect(succeededSlow).not.toBe(runningSlow);
        expect(succeededSlow).toEqual(
            expect.objectContaining({
                running: false,
                isError: false,
                subagent: expect.objectContaining({ status: "succeeded" }),
            }),
        );
        expect(failedFast).toEqual(
            expect.objectContaining({ subagent: expect.objectContaining({ status: "failed" }) }),
        );

        state.messages.push({
            role: "toolResult",
            toolCallId: "slow",
            toolName: "delegator",
            content: [{ type: "text", text: "done" }],
            details: details("slow", "succeeded"),
            isError: false,
            timestamp: 3,
        } as AgentMessage);
        state.isStreaming = false;
        emit({ type: "agent_settled" });
        snapshot = controller.snapshot();
        expect(
            snapshot.display
                .filter((item) => item.kind === "tool")
                .map((item) => [item.toolCallId, item.subagent?.status]),
        ).toEqual([
            ["slow", "succeeded"],
            ["fast", "failed"],
        ]);

        await controller.dispose();
    });

    test("keeps extension-free generic tool updates generic", async () => {
        const call = {
            role: "assistant",
            content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            usage: usage(),
            stopReason: "toolUse",
            timestamp: 1,
        } as AgentMessage;
        const { controller, emit } = await createController([call]);
        emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
        emit({
            type: "tool_execution_update",
            toolCallId: "read-1",
            toolName: "read",
            args: { path: "README.md" },
            partialResult: { content: [{ type: "text", text: "partial read" }], details: { lines: 1 } },
        });
        await Bun.sleep(25);

        expect(controller.snapshot().display[0]).toEqual(
            expect.objectContaining({ kind: "tool", name: "read", running: true, result: "partial read" }),
        );
        const item = controller.snapshot().display[0];
        expect(item && item.kind === "tool" ? item.subagent : undefined).toBeUndefined();
        await controller.dispose();
    });
});

const workflowUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
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
                usage: workflowUsage,
                recentActivity: [],
            },
        ],
        usage: workflowUsage,
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
        prompt: async () => {},
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
    const controller = new PuiController(runtime, { eventBus: bus });
    const bind = (next = session) => controller.bindSession(next);
    return { bus, controller, runtime, session, bind, sessionListener, bindings: () => extensionBindings };
}

describe("PuiController workflow bridge", () => {
    test("does not finish an out-of-order stale session bind", async () => {
        const h = harness(process.cwd());
        let releaseOld!: () => void;
        const oldBinding = new Promise<void>((resolve) => {
            releaseOld = resolve;
        });
        let oldSubscriptions = 0;
        h.session.bindExtensions = () => oldBinding;
        h.session.subscribe = () => {
            oldSubscriptions += 1;
            return () => {};
        };

        let newSubscriptions = 0;
        const replacement = {
            ...h.session,
            sessionId: "session-2",
            bindExtensions: async () => {},
            subscribe: () => {
                newSubscriptions += 1;
                return () => {};
            },
        };
        let autocompleteSetups = 0;
        const controller = h.controller as any;
        const setupAutocomplete = controller.setupAutocompleteProvider.bind(controller);
        controller.setupAutocompleteProvider = () => {
            autocompleteSetups += 1;
            setupAutocomplete();
        };

        const staleBind = h.bind();
        (h.runtime as any).session = replacement;
        await h.bind(replacement);
        const snapshot = h.controller.snapshot();
        releaseOld();
        await staleBind;

        expect(oldSubscriptions).toBe(0);
        expect(newSubscriptions).toBe(1);
        expect(autocompleteSetups).toBe(1);
        expect(h.controller.snapshot()).toBe(snapshot);
        expect(h.controller.snapshot().sessionId).toBe("session-2");
        await h.controller.dispose();
    });

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
            await waitFor(() => h.controller.snapshot().workflows.some((item) => item.id === "run-1"));
            expect(h.controller.snapshot().workflows.map((item) => item.id)).toEqual(["run-1"]);
            expect(h.controller.inspectWorkflow("run-1")?.name).toBe("Review");
            expect(h.controller.handlePrompt("/workflows")).toBe("workflows");
            expect(h.controller.handlePrompt("/workflow review.ts")).toBe("workflow");
            expect(h.controller.handlePrompt("/workflow")).toBe("sent");

            const controls: Array<Record<string, unknown>> = [];
            h.bus.on("pui.workflow.background.control", (value) => controls.push(value as Record<string, unknown>));
            const pause = h.controller.controlWorkflow("run-1", "pause");
            await expect(h.controller.controlWorkflow("run-1", "restart-agent", "missing")).rejects.toThrow(
                "Workflow agent is unavailable.",
            );
            const restart = h.controller.controlWorkflow("run-1", "restart-agent", "agent-1");
            restart.catch(() => {});
            expect(controls).toEqual([
                expect.objectContaining({ action: "pause", runId: "run-1", cwd: canonical }),
                expect.objectContaining({ action: "restart-agent", runId: "run-1", agentId: "agent-1" }),
            ]);
            h.bus.emit("pui.workflow.background.control.result", {
                schema: "pi.workflow.background.control.result",
                version: 1,
                sessionId: "session-1",
                instanceId: "instance-1",
                cwd: canonical,
                requestId: controls[0]?.requestId,
                ok: true,
            });
            await expect(pause).resolves.toBeUndefined();
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
        expect(await ui.confirm("title", "x".repeat(72 * 1024 + 1))).toBe(false);
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
        await waitFor(() => h.controller.snapshot().workflows.some((item) => item.id === "new"));
        expect(h.controller.snapshot().workflows.map((item) => item.id)).toEqual(["new"]);

        const replacement = { ...h.session, sessionId: "session-2" };
        (h.runtime as any).session = replacement;
        await h.bind(replacement);
        expect(h.controller.snapshot().workflows).toEqual([]);
        await expect(h.controller.controlWorkflow("new", "stop")).rejects.toThrow("Workflow control is unavailable.");
        await h.controller.dispose();
    });
});
