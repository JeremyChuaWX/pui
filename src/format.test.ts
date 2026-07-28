import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    boundedWorkflowItems,
    buildDisplayItems,
    formatCount,
    formatToolTitle,
    formatWorkflowSummary,
    reconcileDisplayItems,
    resolveWorkflowRun,
    workflowStatusPresentation,
    workflowStatusTone,
} from "./format.js";

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

    test("formats workflow status and bounds thousand-agent list work", () => {
        const agents = Array.from({ length: 1_000 }, (_, index) => index);
        expect(boundedWorkflowItems(agents, 500)).toEqual(Array.from({ length: 50 }, (_, index) => index + 475));
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
        const legacy = {
            agent: "explore",
            model: "test/model",
            toolCalls: ["read README.md"],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 },
        };
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
                        partialResult: { details: legacy },
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
                subagent: expect.objectContaining({ source: "legacy", status: "failed" }),
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

    test("adapts legacy sessions and falls back for unknown protocol versions", () => {
        const legacy = {
            agent: "explore",
            model: "test/model",
            toolCalls: ["read README.md"],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 },
        };
        const legacyItem = buildDisplayItems(toolMessages("legacy-1", legacy, false))[0];
        expect(legacyItem).toEqual(
            expect.objectContaining({ kind: "tool", subagent: expect.objectContaining({ source: "legacy" }) }),
        );

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
