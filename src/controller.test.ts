import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentSessionEvent, type AgentSessionRuntime, createEventBus } from "@earendil-works/pi-coding-agent";
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
