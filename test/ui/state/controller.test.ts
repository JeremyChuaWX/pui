import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentSessionEvent, type AgentSessionRuntime, createEventBus } from "@earendil-works/pi-coding-agent";
import type { BundledSkillResources } from "#pi-core/bundled-skills.js";
import { type ControllerDependencies, PuiController } from "#ui/state/controller.js";

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

function jobState(id: string, status: "queued" | "running" | "succeeded" | "failed") {
    const terminal = status === "succeeded" || status === "failed";
    return {
        id,
        agent: "explorer",
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
    bundledSkillResources?: BundledSkillResources,
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
    const dependencies: ControllerDependencies = {};
    if (eventBus) dependencies.eventBus = eventBus;
    if (bundledSkillResources) dependencies.bundledSkillResources = bundledSkillResources;
    const controller = new PuiController(runtime, dependencies);
    await controller.bindSession(runtime.session);
    const emit = (event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") state.pending.add(event.toolCallId);
        if (event.type === "tool_execution_end") state.pending.delete(event.toolCallId);
        listener?.(event);
    };
    return { controller, state, emit };
}

describe("PuiController background event bridge", () => {
    test("coalesces current-instance updates and clears owned resources on disposal", async () => {
        const bus = createEventBus();
        let skillDisposals = 0;
        const bundledSkillResources: BundledSkillResources = {
            skills: [],
            skillPaths: [],
            dispose: async () => {
                skillDisposals++;
            },
        };
        const { controller } = await createController([], bus, bundledSkillResources);
        let notifications = 0;
        controller.subscribe(() => notifications++);
        const envelope = (type: string, status = "running") => ({
            schema: "pi.subagent.background",
            version: 1,
            sessionId: "fixture-session",
            instanceId: "live-instance",
            type,
            ...(type === "upsert"
                ? { job: { id: "job", title: "Background", run: jobState("job", status as any) } }
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
        await controller.dispose();
        expect(skillDisposals).toBe(1);
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
    test("keeps sibling tool cards stable while one tool updates", async () => {
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
                partialResult: { content: [{ type: "text", text: "queued" }] },
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
            snapshot.display.filter((item) => item.kind === "tool").map((item) => [item.toolCallId, item.result]),
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
            partialResult: { content: [{ type: "text", text: "working" }] },
        });
        await Bun.sleep(25);
        snapshot = controller.snapshot();
        const runningSlow = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow");
        expect(snapshot.display.find((item) => item.kind === "assistant")).toBe(textItem);
        expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast")).toBe(queuedFast);
        expect(runningSlow).not.toBe(queuedSlow);
        expect(runningSlow).toEqual(expect.objectContaining({ running: true, result: "working" }));

        emit({
            type: "tool_execution_end",
            toolCallId: "fast",
            toolName: "delegator",
            result: { content: [{ type: "text", text: "fixture failure" }] },
            isError: true,
        });
        snapshot = controller.snapshot();
        expect(snapshot.activeTools.map((tool) => tool.id)).toEqual(["slow"]);
        expect(snapshot.display.find((item) => item.kind === "assistant")).toBe(textItem);
        expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow")).toBe(runningSlow);
        const failedFast = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast");
        expect(failedFast).not.toBe(queuedFast);
        expect(failedFast).toEqual(
            expect.objectContaining({ running: false, isError: true, result: "fixture failure" }),
        );

        state.messages.push({
            role: "toolResult",
            toolCallId: "fast",
            toolName: "delegator",
            content: [{ type: "text", text: "fixture failure" }],
            isError: true,
            timestamp: 2,
        } as AgentMessage);
        emit({
            type: "tool_execution_end",
            toolCallId: "slow",
            toolName: "delegator",
            result: { content: [{ type: "text", text: "done" }] },
            isError: false,
        });
        snapshot = controller.snapshot();
        expect(snapshot.activeTools).toEqual([]);
        expect(snapshot.display.find((item) => item.kind === "assistant")).toBe(textItem);
        expect(snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "fast")).toBe(failedFast);
        const succeededSlow = snapshot.display.find((item) => item.kind === "tool" && item.toolCallId === "slow");
        expect(succeededSlow).not.toBe(runningSlow);
        expect(succeededSlow).toEqual(expect.objectContaining({ running: false, isError: false, result: "done" }));

        state.messages.push({
            role: "toolResult",
            toolCallId: "slow",
            toolName: "delegator",
            content: [{ type: "text", text: "done" }],
            isError: false,
            timestamp: 3,
        } as AgentMessage);
        state.isStreaming = false;
        emit({ type: "agent_settled" });
        snapshot = controller.snapshot();
        expect(
            snapshot.display.filter((item) => item.kind === "tool").map((item) => [item.toolCallId, item.isError]),
        ).toEqual([
            ["slow", false],
            ["fast", true],
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
        await controller.dispose();
    });
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

describe("PuiController session binding", () => {
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

    test("bounds a running shell command's transcript output to its tail", async () => {
        const h = harness(process.cwd());
        await h.bind();
        let release!: () => void;
        h.session.executeBash = async (_command: string, onChunk: (chunk: string) => void) => {
            for (let index = 0; index < 5; index += 1) onChunk(`${index}`.repeat(100 * 1024));
            onChunk("tail");
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        };
        expect(h.controller.handlePrompt("! yes")).toBe("sent");
        await Bun.sleep(25);

        const running = h.controller.snapshot().display.find((item) => item.kind === "bash");
        expect(running).toMatchObject({ kind: "bash", command: "yes", running: true });
        const output = (running as { output: string }).output;
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256 * 1024);
        expect(output.endsWith("tail")).toBe(true);
        expect(output.startsWith("0")).toBe(false);
        release();
        await h.controller.dispose();
    });

    test("bounds extension dialogs at the 16 KiB confirm cap", async () => {
        const h = harness(process.cwd());
        await h.bind();
        const ui = h.bindings().uiContext;

        expect(await ui.confirm("x".repeat(513), "body")).toBe(false);
        expect(await ui.confirm("title", "x".repeat(16 * 1024 + 1))).toBe(false);
        expect(
            await ui.select(
                "title",
                Array.from({ length: 101 }, (_, index) => `${index}`),
            ),
        ).toBeUndefined();
        expect(await ui.select("title", ["x".repeat(4097)])).toBeUndefined();
        expect(await ui.input("title", "x".repeat(1025))).toBeUndefined();
        expect(h.controller.snapshot().extensionDialog).toBeUndefined();

        const exact = ui.confirm("title", "x".repeat(16 * 1024));
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
});
