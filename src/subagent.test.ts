import { describe, expect, test } from "bun:test";
import { MAX_SUBAGENT_ACTIVE_TOOLS } from "../extensions/subagent/protocol.ts";
import { normalizeSubagentDetails } from "./subagent.js";
import { compactSubagentUsage, subagentElapsed, subagentStatusIcon, subagentSummary } from "./ui/subagent-view.js";

function protocolDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schema: "pi.subagent",
        version: 1,
        run: {
            id: "outer-1",
            agent: "explore",
            model: "openai/gpt-5.4-mini",
            cwd: "/repo",
            status: "running",
            phase: "tool",
            startedAt: 1_000,
            updatedAt: 2_000,
            activeTools: [{ id: "child-1", name: "read", title: "read src/controller.ts", startedAt: 1_500 }],
            recentActivity: [
                { sequence: 1, timestamp: 1_000, kind: "turn", title: "Turn 1" },
                { sequence: 2, timestamp: 1_500, kind: "tool_start", title: "read src/controller.ts" },
            ],
            usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60, cost: 0.0012, turns: 1 },
            outputPreview: "Working output",
            ...overrides,
        },
    };
}

describe("subagent detail normalization", () => {
    test("normalizes a live protocol snapshot and outer call arguments", () => {
        const view = normalizeSubagentDetails(protocolDetails(), {
            toolCallId: "outer-1",
            args: { prompt: "Inspect controller state", cwd: "/repo" },
        });

        expect(view).toEqual(
            expect.objectContaining({
                id: "outer-1",
                agent: "explore",
                status: "running",
                prompt: "Inspect controller state",
                activeTools: [expect.objectContaining({ title: "read src/controller.ts" })],
            }),
        );
        expect(subagentSummary(view!, 13_000)).toBe(
            "explore · openai/gpt-5.4-mini · running · 12s · 1 turn · 60 tokens",
        );
        expect(subagentSummary(view!, 13_000)).not.toContain("read src/controller.ts");
    });

    test("accepts the producer maximum and rejects oversized active-tool snapshots", () => {
        const tools = Array.from({ length: MAX_SUBAGENT_ACTIVE_TOOLS + 1 }, (_, index) => ({
            id: `tool-${index}`,
            name: "read",
            title: `read ${index}`,
            startedAt: index + 1,
        }));

        expect(normalizeSubagentDetails(protocolDetails({ activeTools: tools.slice(1) }))).toBeDefined();
        expect(normalizeSubagentDetails(protocolDetails({ activeTools: tools }))).toBeUndefined();
    });

    test("recreates terminal protocol state and uses stable elapsed time", () => {
        const view = normalizeSubagentDetails(
            protocolDetails({
                status: "succeeded",
                phase: "exiting",
                activeTools: [],
                endedAt: 15_000,
                usage: {
                    input: 10_000,
                    output: 8_000,
                    cacheRead: 400,
                    cacheWrite: 0,
                    totalTokens: 18_400,
                    cost: 0.0123,
                    turns: 3,
                },
            }),
            { toolCallId: "outer-1" },
        );

        expect(view?.status).toBe("succeeded");
        expect(subagentElapsed(view!, 99_000)).toBe("14s");
        expect(subagentSummary(view!, 99_000)).toBe("explore · openai/gpt-5.4-mini · 14s · 3 turns · 18k tokens");
        expect(compactSubagentUsage(view!.usage)).toBe("3 turns · 18k tokens");
        expect(compactSubagentUsage(view!.usage)).not.toContain("$");
    });

    test("bounds oversized strings for display", () => {
        const view = normalizeSubagentDetails(protocolDetails({ outputPreview: "x".repeat(20_000) }), {
            args: { prompt: "y".repeat(9_000) },
        });
        expect(view?.outputPreview?.length).toBe(16_000);
        expect(view?.outputPreview?.endsWith("…")).toBe(true);
        expect(view?.prompt?.length).toBe(8_000);
    });

    test("rejects malformed payloads, mismatched ids, unknown versions, and pre-protocol shapes", () => {
        expect(normalizeSubagentDetails({ ...protocolDetails(), version: 2 })).toBeUndefined();
        expect(normalizeSubagentDetails(protocolDetails(), { toolCallId: "different" })).toBeUndefined();
        expect(normalizeSubagentDetails(protocolDetails({ recentActivity: "bad" }))).toBeUndefined();
        expect(
            normalizeSubagentDetails({
                agent: "explore",
                toolCalls: ["read README.md"],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
            }),
        ).toBeUndefined();
    });

    test("formats status-specific timing labels", () => {
        const view = normalizeSubagentDetails(
            protocolDetails({ status: "failed", endedAt: 126_000, activeTools: [], error: "boom" }),
        );
        expect(subagentElapsed(view!, 999_999)).toBe("2m 5s");
        expect(subagentStatusIcon("cancelled")).toBe("⊘");
        expect(subagentStatusIcon("timed_out")).toBe("⧖");
    });
});
