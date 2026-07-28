import { describe, expect, test } from "bun:test";
import { parseWorkflowBackgroundEvent, reduceWorkflowEvent, type WorkflowState } from "./workflow.js";

const route = { sessionId: "session-1", cwd: "/canonical/repo" };
function payload(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const value: Record<string, unknown> = {
        schema: "pi.workflow.background",
        version: 1,
        sessionId: route.sessionId,
        instanceId: "instance-1",
        cwd: route.cwd,
        type,
        ...overrides,
    };
    if (type === "upsert" && value.run === undefined) value.run = run();
    if (type === "remove" && value.runId === undefined) value.runId = "run-1";
    return value;
}
function run(): Record<string, unknown> {
    return {
        schema: "pi.workflow",
        version: 1,
        id: "run-1",
        name: "Review",
        sessionId: route.sessionId,
        cwd: route.cwd,
        status: "running",
        phases: [],
        agents: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
        limits: { maxConcurrency: 4, maxAgents: 1_000, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
        recentActivity: [],
        updatedAt: 1,
    };
}
function parse(value: unknown) {
    const event = parseWorkflowBackgroundEvent(value, route);
    if (!event) throw new Error("expected event");
    return event;
}

describe("workflow host protocol", () => {
    test("unknown protocol versions remain generic-fallback-friendly", () => {
        expect(parseWorkflowBackgroundEvent(payload("ready", { version: 2 }), route)).toBeUndefined();
        expect(
            parseWorkflowBackgroundEvent(payload("upsert", { run: { ...run(), version: 2 } }), route),
        ).toBeUndefined();
        expect(parseWorkflowBackgroundEvent(null, route)).toBeUndefined();
    });

    test("immutably reduces ready, upsert, remove, and reset", () => {
        const initial: WorkflowState = { runs: new Map() };
        const ready = reduceWorkflowEvent(initial, parse(payload("ready")), route);
        const upsert = reduceWorkflowEvent(ready, parse(payload("upsert")), route);
        expect(initial.runs.size).toBe(0);
        expect(ready.runs.size).toBe(0);
        expect(upsert.runs.get("run-1")?.name).toBe("Review");
        expect(upsert.runs).not.toBe(ready.runs);
        const removed = reduceWorkflowEvent(upsert, parse(payload("remove")), route);
        expect(removed.runs.size).toBe(0);
        expect(upsert.runs.size).toBe(1);
        const reset = reduceWorkflowEvent(upsert, parse(payload("reset")), route);
        expect(reset).toEqual({ instanceId: "instance-1", acceptingInstance: true, runs: new Map() });
    });

    test("accepts authoritative upserts directly after reset and still rejects stale instances", () => {
        const ready = reduceWorkflowEvent({ runs: new Map() }, parse(payload("ready")), route);
        const reset = reduceWorkflowEvent(ready, parse(payload("reset")), route);
        const upsert = reduceWorkflowEvent(reset, parse(payload("upsert")), route);

        expect(upsert.runs.get("run-1")?.name).toBe("Review");
        expect(reduceWorkflowEvent(reset, parse(payload("upsert", { instanceId: "old" })), route)).toBe(reset);
    });

    test("returns the same state for stale routes and instances", () => {
        const ready = reduceWorkflowEvent({ runs: new Map() }, parse(payload("ready")), route);
        expect(reduceWorkflowEvent(ready, parse(payload("upsert", { instanceId: "old" })), route)).toBe(ready);
        const staleSession = parseWorkflowBackgroundEvent(
            payload("upsert", { sessionId: "old", run: { ...run(), sessionId: "old" } }),
        );
        expect(reduceWorkflowEvent(ready, staleSession!, route)).toBe(ready);
        const staleCwd = parseWorkflowBackgroundEvent(
            payload("upsert", { cwd: "/other", run: { ...run(), cwd: "/other" } }),
        );
        expect(reduceWorkflowEvent(ready, staleCwd!, route)).toBe(ready);
    });

    test("does not let a stale ready replace the authoritative instance", () => {
        const ready = reduceWorkflowEvent({ runs: new Map() }, parse(payload("ready")), route);
        expect(reduceWorkflowEvent(ready, parse(payload("ready", { instanceId: "new" })), route)).toBe(ready);
    });
});
