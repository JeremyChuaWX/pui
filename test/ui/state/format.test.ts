import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { buildDisplayItems, formatCount, formatToolTitle } from "#ui/state/format.js";
import { reduceToolExecutions, type ToolExecutionState } from "#ui/state/tool-executions.js";

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
                details: {
                    id: "explorer_1",
                    profile: "explorer",
                    task: "inspect",
                    status: "completed",
                    runtimeMs: 1_000,
                    partial: false,
                    totalTokens: 2_000,
                    location: "/tmp/explorer_1.md",
                    preview: "Found it.",
                },
                timestamp: 1,
            },
        ] as AgentMessage[]);

        expect(item).toEqual({
            id: "0:1",
            kind: "subagentResult",
            result: {
                id: "explorer_1",
                profile: "explorer",
                task: "inspect",
                status: "completed",
                runtimeMs: 1_000,
                partial: false,
                totalTokens: 2_000,
                location: "/tmp/explorer_1.md",
                preview: "Found it.",
            },
        });
    });

    test("shows a live execution as running with its partial output, then its final result", () => {
        const call = {
            role: "assistant",
            content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }],
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
        const args = { path: "README.md" };
        let executions: ToolExecutionState = new Map();
        const apply = (event: AgentSessionEvent, now: number) => {
            if (
                event.type === "tool_execution_start" ||
                event.type === "tool_execution_update" ||
                event.type === "tool_execution_end"
            )
                executions = reduceToolExecutions(executions, event, now);
        };

        apply({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args }, 10);
        apply(
            {
                type: "tool_execution_update",
                toolCallId: "read-1",
                toolName: "read",
                args,
                partialResult: { content: [{ type: "text", text: "partial" }] },
            },
            20,
        );
        expect(buildDisplayItems([call], undefined, { toolExecutions: executions })[0]).toEqual(
            expect.objectContaining({ kind: "tool", running: true, result: "partial" }),
        );

        apply(
            {
                type: "tool_execution_end",
                toolCallId: "read-1",
                toolName: "read",
                result: { content: [{ type: "text", text: "final" }] },
                isError: false,
            },
            30,
        );
        expect(buildDisplayItems([call], undefined, { toolExecutions: executions })[0]).toEqual(
            expect.objectContaining({ kind: "tool", running: false, isError: false, result: "final" }),
        );
    });

    test("formats compact token counts and tool labels", () => {
        expect(formatCount(1_250)).toBe("1.3k");
        expect(formatToolTitle("bash", { command: "git status" })).toBe("bash  git status");
    });
});
