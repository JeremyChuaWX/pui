import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { collect } from "#modules/subagents/subagent.js";

function assistant(text: string, totalTokens: number, stopReason: "stop" | "toolUse" = "stop"): AgentMessage {
    return {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        api: "fixture-api",
        provider: "fixture-provider",
        model: "fixture-model",
        usage: {
            input: 2,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
        stopReason,
        timestamp: 1,
    };
}

describe("subagent result collection", () => {
    test("uses the final assistant text and sums usage", () => {
        const session = {
            state: { messages: [assistant("first", 5), assistant("final", 7)] },
        } as unknown as Parameters<typeof collect>[0];
        expect(collect(session)).toEqual({
            text: "final",
            partial: false,
            usage: { input: 4, output: 6, totalTokens: 12, cost: 0.02 },
        });
    });

    test("falls back to earlier text and marks it partial", () => {
        const session = {
            state: { messages: [assistant("usable", 5), assistant("", 7, "toolUse")] },
        } as unknown as Parameters<typeof collect>[0];
        expect(collect(session)).toMatchObject({ text: "usable", partial: true });
    });

    test("returns an empty partial result when there is no assistant response", () => {
        const session = { state: { messages: [] } } as unknown as Parameters<typeof collect>[0];
        expect(collect(session)).toEqual({
            text: "",
            partial: true,
            usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
        });
    });
});
