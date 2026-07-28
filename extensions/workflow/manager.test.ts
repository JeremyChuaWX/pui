import { describe, expect, test } from "bun:test";
import type { WorkflowBackend } from "./backend.js";
import { WorkflowRunManager } from "./manager.js";
import type { WorkflowRunSummaryV1 } from "./protocol.js";

const run = (status: WorkflowRunSummaryV1["status"]): WorkflowRunSummaryV1 => ({
    schema: "pi.workflow",
    version: 1,
    id: "r",
    name: "n",
    sessionId: "s",
    cwd: "/x",
    status,
    phases: [],
    agents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
    recentActivity: [],
    updatedAt: 1,
});
test("manager delivers a repeated terminal snapshot exactly once and shuts backend down", async () => {
    let listener: (run: WorkflowRunSummaryV1) => void = () => {};
    let shutdown = 0,
        unsubscribed = 0;
    const backend: WorkflowBackend = {
        launch: async () => ({ runId: "r" }),
        list: () => [],
        inspect: () => ({ run: run("succeeded"), script: "", result: "ok" }),
        subscribe: (fn) => {
            listener = fn;
            return () => unsubscribed++;
        },
        control: async () => {},
        shutdown: async () => {
            shutdown++;
        },
    };
    const delivered: any[] = [];
    const manager = new WorkflowRunManager({ backend, emit: () => {}, deliver: (...args) => delivered.push(args) });
    listener(run("succeeded"));
    listener(run("succeeded"));
    expect(delivered).toHaveLength(1);
    await manager.shutdown();
    await manager.shutdown();
    expect(shutdown).toBe(1);
    expect(unsubscribed).toBe(1);
});
