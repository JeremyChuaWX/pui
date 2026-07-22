import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { buildDisplayItems } from "./format.js";
import { reduceToolExecutions, type ToolExecutionState } from "./tool-executions.js";

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
): Record<string, unknown> {
    const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
    return {
        schema: "pi.subagent",
        version: 1,
        run: {
            id,
            agent: "explore",
            model: "fixture/model",
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
