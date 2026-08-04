import { describe, expect, test } from "bun:test";
import {
    MAX_WORKFLOW_AGENTS,
    MAX_WORKFLOW_DETAIL,
    parseBackgroundWorkflowControl,
    parseBackgroundWorkflowEvent,
    parseWorkflowDetailsV1,
    parseWorkflowRunV1,
    truncateWorkflowText,
} from "./protocol.js";
import { workflowRun } from "./test-support/workflow-fixture.js";

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
        run.agents[0].error = "x".repeat(MAX_WORKFLOW_DETAIL + 1);
        expect(parseWorkflowRunV1(run)).toBeUndefined();

        const worktree = workflowRun();
        worktree.agents[0].worktree = { cwd: "/tmp/worktree", branch: "workflow/run-1" };
        expect(parseWorkflowRunV1(worktree)).toBeDefined();
        for (const malformed of [
            { cwd: "/tmp/worktree" },
            { branch: "workflow/run-1" },
            { cwd: "", branch: "workflow/run-1" },
            { cwd: "/tmp/worktree", branch: 1 },
        ]) {
            worktree.agents[0].worktree = malformed;
            expect(parseWorkflowRunV1(worktree)).toBeUndefined();
        }
    });

    test("bounds producer text without splitting Unicode code points", () => {
        expect(truncateWorkflowText("A😀界B", 3)).toBe("A…");
        expect(truncateWorkflowText("😀x", 2)).toBe("…");
        expect(truncateWorkflowText("😀x", 0)).toBe("");
        expect(truncateWorkflowText("😀x", -1)).toBe("");
        expect(truncateWorkflowText("😀x", 0.5)).toBe("");
        expect(truncateWorkflowText("😀x", Number.NaN)).toBe("");
        expect(truncateWorkflowText("😀", 2)).toBe("😀");
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

const route = { sessionId: "session-1", instanceId: "instance-1", cwd: "/canonical/repo" };
const envelope = (type: string, extra: Record<string, unknown> = {}) => ({
    schema: "pi.workflow.background",
    version: 1,
    ...route,
    type,
    ...extra,
});
const control = (action: string, extra: Record<string, unknown> = {}) => ({
    schema: "pi.workflow.background.control",
    version: 1,
    ...route,
    requestId: "request-1",
    action,
    runId: "run-1",
    ...extra,
});

describe("background workflow protocol", () => {
    test("parses routed snapshots and rejects stale or unknown events", () => {
        expect(parseBackgroundWorkflowEvent(envelope("ready"), route)?.type).toBe("ready");
        expect(parseBackgroundWorkflowEvent(envelope("upsert", { run: workflowRun() }), route)?.type).toBe("upsert");
        expect(parseBackgroundWorkflowEvent(envelope("remove", { runId: "run-1" }), route)).toBeUndefined();
        expect(parseBackgroundWorkflowEvent(envelope("ready", { sessionId: "stale" }), route)).toBeUndefined();
        expect(parseBackgroundWorkflowEvent(envelope("ready", { instanceId: "stale" }), route)).toBeUndefined();
        expect(parseBackgroundWorkflowEvent(envelope("ready", { version: 2 }), route)).toBeUndefined();
        expect(parseBackgroundWorkflowEvent(envelope("future"), route)).toBeUndefined();
    });

    test("rejects invalid controls and exact-route mismatches", () => {
        expect(parseBackgroundWorkflowControl(control("pause"), route)?.action).toBe("pause");
        expect(parseBackgroundWorkflowControl(control("restart-agent", { agentId: "agent-1" }), route)?.agentId).toBe(
            "agent-1",
        );
        for (const invalid of [
            control("future"),
            control("restart-agent"),
            control("stop", { agentId: "agent-1" }),
            control("pause", { runId: "" }),
            control("pause", { sessionId: "stale" }),
            control("pause", { instanceId: "stale" }),
            control("pause", { cwd: "/other" }),
            control("pause", { version: 2 }),
        ])
            expect(parseBackgroundWorkflowControl(invalid, route)).toBeUndefined();
    });
});
