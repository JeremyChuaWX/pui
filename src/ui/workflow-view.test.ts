import { describe, expect, test } from "bun:test";
import { formatWorkflowSummary, workflowStatusPresentation, workflowStatusTone } from "./workflow-view.js";

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

describe("workflow view", () => {
    test("formats workflow status", () => {
        expect(workflowStatusPresentation("timed_out")).toEqual({ icon: "×", label: "Timed out" });
        expect(workflowStatusTone("failed")).toBe("error");
        expect(formatWorkflowSummary(workflowRun())).toBe("◌ Review · Running · 0/1 agents · review");
    });
});
