import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
    buildDisplayItems,
    formatCount,
    formatToolTitle,
    formatWorkflowSummary,
    reconcileDisplayItems,
    resolveWorkflowRun,
    workflowStatusPresentation,
    workflowStatusTone,
} from "./format.js";
import { reduceToolExecutions, type ToolExecutionState } from "./tool-executions.js";

describe("pui formatting", () => {
    test("combines a tool call with its result", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "test",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: 1,
            },
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [{ type: "text", text: "# Dotfiles" }],
                isError: false,
                timestamp: 2,
            },
        ] as AgentMessage[];

        expect(buildDisplayItems(messages)).toEqual([
            expect.objectContaining({ kind: "tool", title: "read  README.md", result: "# Dotfiles", isError: false }),
        ]);
    });

    test("keeps an assistant block identity stable when streaming completes", () => {
        const message = {
            role: "assistant",
            content: [{ type: "text", text: "## Stable heading" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 42,
        } as AgentMessage;

        const streaming = buildDisplayItems([], message)[0];
        const completed = buildDisplayItems([message])[0];
        expect(streaming?.id).toBe(completed?.id);
        expect(streaming).toEqual(expect.objectContaining({ kind: "assistant", streaming: true }));
        expect(completed).toEqual(expect.objectContaining({ kind: "assistant", streaming: false }));
    });

    test("projects a resumed background result to its dedicated custom display", () => {
        const [item] = buildDisplayItems([
            {
                role: "custom",
                customType: "subagent-result",
                content: "Background subagent fixture succeeded.",
                display: true,
                details: { id: "job-1", title: "fixture", status: "succeeded" },
                timestamp: 1,
            },
        ] as AgentMessage[]);

        expect(item).toEqual({
            id: "0:1",
            kind: "custom",
            label: "subagent-result",
            text: "Background subagent fixture succeeded.",
        });
    });

    test("formats compact token counts and tool labels", () => {
        expect(formatCount(1_250)).toBe("1.3k");
        expect(formatToolTitle("bash", { command: "git status" })).toBe("bash  git status");
    });

    test("formats workflow status", () => {
        expect(workflowStatusPresentation("timed_out")).toEqual({ icon: "×", label: "Timed out" });
        expect(workflowStatusTone("failed")).toBe("error");
        expect(formatWorkflowSummary(workflowRun())).toBe("◌ Review · Running · 0/1 agents · review");
    });

    test("resolves embedded summaries and actual v1 launch details against authoritative runs", () => {
        const run = workflowRun();
        expect(resolveWorkflowRun({ schema: "pi.workflow", version: 1, run })).toEqual({ run, runId: "run-1" });

        const launch = { schema: "pi.workflow.launch", version: 1, runId: "run-1", preflight: { agents: 1 } };
        expect(resolveWorkflowRun(launch, [run])).toEqual({ run, runId: "run-1" });
        expect(buildDisplayItems(workflowMessages(launch, true), undefined, { workflows: [run] })[0]).toEqual(
            expect.objectContaining({
                kind: "tool",
                workflowRunId: "run-1",
                workflow: expect.objectContaining({ id: "run-1" }),
            }),
        );
    });

    test("keeps malformed, unknown, and unavailable launches generic", () => {
        for (const details of [
            { schema: "pi.workflow.launch", version: 2, runId: "run-1" },
            { schema: "pi.workflow", version: 2, run: workflowRun() },
            { schema: "pi.workflow.launch", version: 1, runId: "" },
            { schema: "pi.workflow.launch", version: 1, runId: "x".repeat(257) },
            { schema: "pi.workflow.launch", version: 1, runId: 42 },
        ]) {
            const item = buildDisplayItems(workflowMessages(details, true), undefined, {
                workflows: [workflowRun()],
            })[0];
            expect(item).toEqual(expect.objectContaining({ kind: "tool", result: "started" }));
            expect(item && "workflow" in item ? item.workflow : undefined).toBeUndefined();
            expect(item && "workflowRunId" in item ? item.workflowRunId : undefined).toBeUndefined();
        }
        const unavailable = buildDisplayItems(
            workflowMessages({ schema: "pi.workflow.launch", version: 1, runId: "missing" }, true),
        )[0];
        expect(unavailable && "workflow" in unavailable ? unavailable.workflow : undefined).toBeUndefined();
        expect(unavailable && "workflowRunId" in unavailable ? unavailable.workflowRunId : undefined).toBe("missing");
    });

    test("presentation reconciliation notices launch run ID changes", () => {
        const launch = (runId: string) =>
            buildDisplayItems(workflowMessages({ schema: "pi.workflow.launch", version: 1, runId }, true))[0];
        const previous = launch("run-1");
        const next = launch("run-2");
        expect(reconcileDisplayItems([previous], [next])[0]).toBe(next);
    });

    test("reconciles live workflow changes for the same run ID", () => {
        const run = workflowRun();
        const launch = { schema: "pi.workflow.launch", version: 1, runId: run.id };
        const previous = buildDisplayItems(workflowMessages(launch, true), undefined, { workflows: [run] })[0];
        const changed = { ...run, status: "succeeded" as const, updatedAt: run.updatedAt + 1 };
        const next = buildDisplayItems(workflowMessages(launch, true), undefined, { workflows: [changed] })[0];

        expect(previous && "workflowKey" in previous ? previous.workflowKey : undefined).not.toBe(
            next && "workflowKey" in next ? next.workflowKey : undefined,
        );
        expect(reconcileDisplayItems([previous], [next])[0]).toBe(next);
    });

    test("prefers live partial subagent details and reducer-derived running state", () => {
        const call = {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "sub-1",
                    name: "delegator",
                    arguments: { agent: "explore", prompt: "Inspect the reducer", cwd: "/repo" },
                },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
        } as AgentMessage;
        const details = subagentDetails("sub-1", "running");
        const display = buildDisplayItems([call], undefined, {
            toolExecutions: new Map([
                [
                    "sub-1",
                    {
                        id: "sub-1",
                        name: "delegator",
                        args: { agent: "explore", prompt: "Inspect the reducer", cwd: "/repo" },
                        status: "running",
                        startedAt: 10,
                        updatedAt: 20,
                        partialResult: { content: [{ type: "text", text: "running" }], details },
                    },
                ],
            ]),
        });

        expect(display[0]).toEqual(
            expect.objectContaining({
                kind: "tool",
                running: true,
                subagent: expect.objectContaining({ status: "running", prompt: "Inspect the reducer" }),
            }),
        );
    });

    test("restores completed subagent presentation from persisted result details", () => {
        const messages = toolMessages("resume-1", subagentDetails("resume-1", "timed_out"), true);
        const item = buildDisplayItems(messages)[0];

        expect(item).toEqual(
            expect.objectContaining({
                kind: "tool",
                running: false,
                isError: true,
                subagent: expect.objectContaining({ id: "resume-1", status: "timed_out" }),
            }),
        );
    });

    test("falls back to partial details when persisted result details are undefined", () => {
        const messages = toolMessages("persisted-fallback-1", undefined, true);
        const item = buildDisplayItems(messages, undefined, {
            toolExecutions: new Map([
                [
                    "persisted-fallback-1",
                    {
                        id: "persisted-fallback-1",
                        name: "delegator",
                        args: { agent: "explore", prompt: "Inspect the repository", cwd: "/repo" },
                        status: "ended",
                        startedAt: 10,
                        updatedAt: 30,
                        partialResult: { details: subagentDetails("persisted-fallback-1", "running") },
                        finalResult: { content: [{ type: "text", text: "delegated output" }] },
                        isError: true,
                    },
                ],
            ]),
        })[0];

        expect(item).toEqual(
            expect.objectContaining({
                kind: "tool",
                running: false,
                isError: true,
                subagent: expect.objectContaining({ id: "persisted-fallback-1", status: "running" }),
            }),
        );
    });

    test("falls back to partial details when a final result has no details", () => {
        const [call] = toolMessages("fallback-1", undefined, false);
        const item = buildDisplayItems([call], undefined, {
            toolExecutions: new Map([
                [
                    "fallback-1",
                    {
                        id: "fallback-1",
                        name: "delegator",
                        args: { agent: "explore", prompt: "Inspect the repository", cwd: "/repo" },
                        status: "ended",
                        startedAt: 10,
                        updatedAt: 30,
                        partialResult: {
                            content: [{ type: "text", text: "running" }],
                            details: subagentDetails("fallback-1", "running"),
                        },
                        finalResult: { content: [{ type: "text", text: "done" }] },
                        isError: false,
                    },
                ],
            ]),
        })[0];

        expect(item).toEqual(
            expect.objectContaining({
                kind: "tool",
                running: false,
                subagent: expect.objectContaining({ id: "fallback-1", status: "running" }),
            }),
        );
    });

    test("keeps pre-protocol details and unknown protocol versions generic", () => {
        const legacy = {
            agent: "explore",
            model: "test/model",
            toolCalls: ["read README.md"],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 },
        };
        const legacyItem = buildDisplayItems(toolMessages("legacy-1", legacy, false))[0];
        expect(legacyItem).toEqual(expect.objectContaining({ kind: "tool", result: "delegated output" }));
        expect(legacyItem && "subagent" in legacyItem ? legacyItem.subagent : undefined).toBeUndefined();

        const unknownItem = buildDisplayItems(
            toolMessages("future-1", { ...subagentDetails("future-1", "succeeded"), version: 2 }, false),
        )[0];
        expect(unknownItem).toEqual(expect.objectContaining({ kind: "tool", result: "delegated output" }));
        expect(unknownItem && "subagent" in unknownItem ? unknownItem.subagent : undefined).toBeUndefined();
    });
});

function workflowRun() {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 };
    return {
        schema: "pi.workflow" as const,
        version: 1 as const,
        id: "run-1",
        name: "Review",
        sessionId: "session-1",
        cwd: "/repo",
        status: "running" as const,
        currentPhase: "review",
        phases: [],
        agents: [
            {
                id: "agent-1",
                label: "Reviewer",
                role: "explore",
                status: "running" as const,
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

function workflowMessages(details: unknown, raw = false): AgentMessage[] {
    return [
        {
            role: "toolResult",
            toolCallId: "workflow-1",
            toolName: "workflow",
            content: [{ type: "text", text: "started" }],
            details: raw ? details : { schema: "pi.workflow", version: 1, run: details },
            isError: false,
            timestamp: 1,
        },
    ] as AgentMessage[];
}

function subagentDetails(id: string, status: "running" | "succeeded" | "timed_out"): Record<string, unknown> {
    const terminal = status !== "running";
    return {
        schema: "pi.subagent",
        version: 1,
        run: {
            id,
            agent: "explore",
            model: "test/model",
            cwd: "/repo",
            status,
            phase: terminal ? "exiting" : "thinking",
            startedAt: 10,
            updatedAt: 20,
            ...(terminal ? { endedAt: 30 } : {}),
            activeTools: [],
            recentActivity: [],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 },
            ...(status === "timed_out" ? { error: "Timed out after 120s" } : {}),
        },
    };
}

function toolMessages(id: string, details: unknown, isError: boolean): AgentMessage[] {
    return [
        {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id,
                    name: "delegator",
                    arguments: { agent: "explore", prompt: "Inspect the repository", cwd: "/repo" },
                },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
        },
        {
            role: "toolResult",
            toolCallId: id,
            toolName: "delegator",
            content: [{ type: "text", text: "delegated output" }],
            details,
            isError,
            timestamp: 2,
        },
    ] as AgentMessage[];
}

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

function assistantCalls(ids: string[], name = "subagent"): AgentMessage {
    return {
        role: "assistant",
        content: ids.map((id) => ({
            type: "toolCall" as const,
            id,
            name,
            arguments: { agent: "explore", prompt: `Inspect ${id}`, cwd: "/repo" },
        })),
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: usage(),
        stopReason: "toolUse",
        timestamp: 1,
    } as AgentMessage;
}

function details(
    id: string,
    status: "queued" | "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out",
    model = "fixture/model",
): Record<string, unknown> {
    const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
    return {
        schema: "pi.subagent",
        version: 1,
        run: {
            id,
            agent: "explore",
            model,
            cwd: "/repo",
            status,
            phase:
                status === "queued" ? "queued" : status === "starting" ? "spawning" : terminal ? "exiting" : "thinking",
            ...(status === "queued" ? {} : { startedAt: 10 }),
            updatedAt: 20,
            ...(terminal ? { endedAt: 30 } : {}),
            activeTools: [],
            recentActivity: [],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, turns: 1 },
            ...(terminal && status !== "succeeded" ? { error: `fixture ${status}` } : {}),
        },
    };
}

function apply(state: ToolExecutionState, event: AgentSessionEvent, now: number): ToolExecutionState {
    if (
        event.type !== "tool_execution_start" &&
        event.type !== "tool_execution_update" &&
        event.type !== "tool_execution_end"
    ) {
        return state;
    }
    return reduceToolExecutions(state, event, now);
}

describe("extension update to host display integration", () => {
    test("carries five independently queued snapshots through reducer and formatter", () => {
        const ids = ["run-1", "run-2", "run-3", "run-4", "run-5"];
        let state: ToolExecutionState = new Map();
        ids.forEach((id, index) => {
            state = apply(
                state,
                {
                    type: "tool_execution_start",
                    toolCallId: id,
                    toolName: "subagent",
                    args: { agent: "explore", prompt: `Inspect ${id}`, cwd: "/repo" },
                },
                index,
            );
            state = apply(
                state,
                {
                    type: "tool_execution_update",
                    toolCallId: id,
                    toolName: "subagent",
                    args: { agent: "explore", prompt: `Inspect ${id}`, cwd: "/repo" },
                    partialResult: { content: [{ type: "text", text: "queued" }], details: details(id, "queued") },
                },
                index + 10,
            );
        });

        const cards = buildDisplayItems([assistantCalls(ids)], undefined, { toolExecutions: state }).filter(
            (item) => item.kind === "tool",
        );
        expect(cards).toHaveLength(5);
        expect(cards.map((card) => card.subagent?.id)).toEqual(ids);
        expect(cards.map((card) => card.subagent?.status)).toEqual(ids.map(() => "queued"));
    });

    test("reconciles progress without changing display solely for a shortened model id", () => {
        const id = "stable-model";
        let state: ToolExecutionState = new Map();
        state = apply(
            state,
            {
                type: "tool_execution_start",
                toolCallId: id,
                toolName: "subagent",
                args: { agent: "explore", prompt: "Inspect labels", cwd: "/repo" },
            },
            1,
        );
        state = apply(
            state,
            {
                type: "tool_execution_update",
                toolCallId: id,
                toolName: "subagent",
                args: { agent: "explore", prompt: "Inspect labels", cwd: "/repo" },
                partialResult: {
                    content: [{ type: "text", text: "running" }],
                    details: details(id, "running", "openai-codex/gpt-5.4-mini:off"),
                },
            },
            2,
        );

        const before = buildDisplayItems([assistantCalls([id])], undefined, { toolExecutions: state })[0];
        state = apply(
            state,
            {
                type: "tool_execution_update",
                toolCallId: id,
                toolName: "subagent",
                args: { agent: "explore", prompt: "Inspect labels", cwd: "/repo" },
                partialResult: {
                    content: [{ type: "text", text: "still running" }],
                    details: details(id, "running", "openai-codex/gpt-5.4-mini:off"),
                },
            },
            3,
        );
        const after = buildDisplayItems([assistantCalls([id])], undefined, { toolExecutions: state })[0];

        expect(before && "subagent" in before ? before.subagent?.model : undefined).toBe(
            "openai-codex/gpt-5.4-mini:off",
        );
        expect(after && "subagent" in after ? after.subagent?.model : undefined).toBe("openai-codex/gpt-5.4-mini:off");
    });

    test("keeps sibling status and final details correct when completion order differs", () => {
        const ids = ["slow-success", "fast-failure"];
        let state: ToolExecutionState = new Map();
        for (const id of ids) {
            state = apply(
                state,
                {
                    type: "tool_execution_start",
                    toolCallId: id,
                    toolName: "subagent",
                    args: { agent: "explore", prompt: `Inspect ${id}`, cwd: "/repo" },
                },
                1,
            );
            state = apply(
                state,
                {
                    type: "tool_execution_update",
                    toolCallId: id,
                    toolName: "subagent",
                    args: { agent: "explore", prompt: `Inspect ${id}`, cwd: "/repo" },
                    partialResult: { content: [{ type: "text", text: "running" }], details: details(id, "running") },
                },
                2,
            );
        }

        state = apply(
            state,
            {
                type: "tool_execution_end",
                toolCallId: "fast-failure",
                toolName: "subagent",
                result: {
                    content: [{ type: "text", text: "fixture failed" }],
                    details: details("fast-failure", "failed"),
                },
                isError: true,
            },
            3,
        );
        let cards = buildDisplayItems([assistantCalls(ids)], undefined, { toolExecutions: state }).filter(
            (item) => item.kind === "tool",
        );
        expect(cards.map((card) => [card.toolCallId, card.running, card.subagent?.status])).toEqual([
            ["slow-success", true, "running"],
            ["fast-failure", false, "failed"],
        ]);

        state = apply(
            state,
            {
                type: "tool_execution_end",
                toolCallId: "slow-success",
                toolName: "subagent",
                result: {
                    content: [{ type: "text", text: "finished" }],
                    details: details("slow-success", "succeeded"),
                },
                isError: false,
            },
            4,
        );
        cards = buildDisplayItems([assistantCalls(ids)], undefined, { toolExecutions: state }).filter(
            (item) => item.kind === "tool",
        );
        expect(cards.map((card) => card.subagent?.status)).toEqual(["succeeded", "failed"]);
    });

    test.each(["cancelled", "timed_out"] as const)(
        "renders %s terminal details without guessing from the tool name",
        (status) => {
            const id = `run-${status}`;
            const messages = [
                assistantCalls([id], "delegator"),
                {
                    role: "toolResult",
                    toolCallId: id,
                    toolName: "delegator",
                    content: [{ type: "text", text: `fixture ${status}` }],
                    details: details(id, status),
                    isError: true,
                    timestamp: 2,
                } as AgentMessage,
            ];
            const card = buildDisplayItems(messages)[0];
            expect(card).toEqual(
                expect.objectContaining({
                    kind: "tool",
                    name: "delegator",
                    subagent: expect.objectContaining({ status }),
                }),
            );
        },
    );

    test("malformed details and extension-free generic tools retain generic presentation", () => {
        const genericNames = ["read", "bash", "web_search"];
        for (const [index, name] of genericNames.entries()) {
            const id = `generic-${index}`;
            let state: ToolExecutionState = new Map();
            const args =
                name === "read" ? { path: "README.md" } : name === "bash" ? { command: "pwd" } : { query: "Pi" };
            state = apply(state, { type: "tool_execution_start", toolCallId: id, toolName: name, args }, 1);
            state = apply(
                state,
                {
                    type: "tool_execution_update",
                    toolCallId: id,
                    toolName: name,
                    args,
                    partialResult: {
                        content: [{ type: "text", text: "partial generic output" }],
                        details: { schema: "pi.subagent", version: 99, run: "malformed" },
                    },
                },
                2,
            );
            const card = buildDisplayItems([assistantCalls([id], name)], undefined, { toolExecutions: state })[0];
            expect(card).toEqual(
                expect.objectContaining({ kind: "tool", name, running: true, result: "partial generic output" }),
            );
            expect(card && "subagent" in card ? card.subagent : undefined).toBeUndefined();
        }
    });
});
