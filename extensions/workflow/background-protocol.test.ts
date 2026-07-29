import { describe, expect, test } from "bun:test";
import { parseBackgroundWorkflowControl, parseBackgroundWorkflowEvent } from "./background-protocol.js";
import { workflowRun } from "./workflow-fixture.js";

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
        expect(parseBackgroundWorkflowEvent(envelope("remove", { runId: "run-1" }), route)?.type).toBe("remove");
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
