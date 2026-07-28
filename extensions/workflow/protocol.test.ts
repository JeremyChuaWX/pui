import { describe, expect, test } from "bun:test";
import {
    MAX_WORKFLOW_AGENTS,
    MAX_WORKFLOW_DETAIL,
    parseWorkflowDetailsV1,
    parseWorkflowRunV1,
    truncateWorkflowText,
} from "./protocol.js";

export function workflowRun(agentCount = 1): Record<string, any> {
    const agents = Array.from({ length: agentCount }, (_, index) => ({
        id: `agent-${index}`,
        label: `Agent ${index}`,
        role: "worker",
        status: "running",
        updatedAt: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
        recentActivity: [],
    }));
    return {
        schema: "pi.workflow",
        version: 1,
        id: "run-1",
        name: "Review",
        sessionId: "session-1",
        cwd: "/canonical/repo",
        status: "running",
        phases: [{ id: "phase-1", name: "Review", status: "running", updatedAt: 2, agentIds: agents.map((a) => a.id) }],
        agents,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
        limits: { maxConcurrency: 4, maxAgents: 1_000, timeoutMs: 60_000, maxTokens: 0, maxCost: 0 },
        recentActivity: [],
        updatedAt: 2,
    };
}

describe("workflow v1 protocol", () => {
    test("accepts a bounded synthetic 1,000-agent authoritative snapshot", () => {
        const run = workflowRun(MAX_WORKFLOW_AGENTS);
        expect(parseWorkflowRunV1(run)?.agents).toHaveLength(1_000);
        run.agents.push({ ...run.agents[0], id: "overflow" });
        expect(parseWorkflowRunV1(run)).toBeUndefined();
    });

    test("rejects malformed, unknown, duplicate, and oversized values", () => {
        const run = workflowRun();
        expect(parseWorkflowRunV1({ ...run, version: 2 })).toBeUndefined();
        expect(parseWorkflowRunV1({ ...run, status: "future" })).toBeUndefined();
        expect(parseWorkflowRunV1({ ...run, usage: { ...run.usage, cost: Number.NaN } })).toBeUndefined();
        expect(parseWorkflowRunV1({ ...run, agents: [run.agents[0], run.agents[0]] })).toBeUndefined();
        run.agents[0].output = "x".repeat(MAX_WORKFLOW_DETAIL + 1);
        expect(parseWorkflowRunV1(run)).toBeUndefined();
    });

    test("bounds producer text without splitting Unicode code points", () => {
        expect(truncateWorkflowText("A😀界B", 3)).toBe("A😀…");
        const run = workflowRun();
        expect(
            parseWorkflowDetailsV1({
                schema: "pi.workflow",
                version: 1,
                run,
                script: "x".repeat(MAX_WORKFLOW_DETAIL + 1),
            }),
        ).toBeUndefined();
    });
});
