import { describe, expect, test } from "bun:test";
import {
    formatWorkflowSummary,
    resolveWorkflowNavigation,
    WORKFLOW_NAVIGATION_TIMEOUT_MS,
    workflowStatusPresentation,
    workflowStatusTone,
} from "./workflow-view.js";

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

describe("resolveWorkflowNavigation", () => {
    const pending = { ids: new Set(["existing"]), requestedAt: 1_000, sessionId: "session-1" };

    test("expires on session replacement or after the timeout window", () => {
        expect(resolveWorkflowNavigation(pending, { sessionId: "session-2", workflows: [] }, 1_001)).toEqual({
            kind: "expire",
        });
        expect(
            resolveWorkflowNavigation(
                pending,
                { sessionId: "session-1", workflows: [] },
                1_000 + WORKFLOW_NAVIGATION_TIMEOUT_MS,
            ),
        ).toEqual({ kind: "expire" });
    });

    test("navigates to the most recently updated run that is new since the request", () => {
        const workflows = [
            { ...workflowRun(), id: "existing", updatedAt: 5_000 },
            { ...workflowRun(), id: "stale", updatedAt: 999 },
            { ...workflowRun(), id: "new-early", updatedAt: 1_500 },
            { ...workflowRun(), id: "new-late", updatedAt: 2_000 },
        ];
        expect(resolveWorkflowNavigation(pending, { sessionId: "session-1", workflows }, 2_500)).toEqual({
            kind: "navigate",
            runId: "new-late",
        });
    });

    test("waits for the remainder of the timeout window when no new run has appeared", () => {
        const workflows = [{ ...workflowRun(), id: "existing", updatedAt: 5_000 }];
        expect(resolveWorkflowNavigation(pending, { sessionId: "session-1", workflows }, 11_000)).toEqual({
            kind: "wait",
            recheckInMs: WORKFLOW_NAVIGATION_TIMEOUT_MS - 10_000,
        });
    });
});
