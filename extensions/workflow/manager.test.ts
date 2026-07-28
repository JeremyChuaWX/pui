import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowBackend, type WorkflowBackend } from "./backend.js";
import { WorkflowRunManager } from "./manager.js";
import type { WorkflowRunSummaryV1 } from "./protocol.js";
import { WorkflowRunStorage } from "./run-storage.js";

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

test("durably delivers recovered terminal runs across storage instances", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-delivery-"));
    const project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    const root = path.join(temp, "runs");
    const storageA = new WorkflowRunStorage(root);
    const managers: WorkflowRunManager[] = [];
    const backend = (storage = new WorkflowRunStorage(root)) =>
        createWorkflowBackend({ storage, agentExecutor: async () => ({ value: null }) });
    const persist = async (id: string, result: unknown) => {
        const summary = { ...run("succeeded"), id, cwd: project, endedAt: 2 };
        const directory = await storageA.create(
            project,
            id,
            {
                name: summary.name,
                sessionId: summary.sessionId,
                cwd: project,
                script: "return null",
                policy: {},
                roles: [],
                models: [],
                limits: summary.limits,
            },
            { ...summary, status: "running" },
        );
        await storageA.terminal(directory, result, summary);
        return directory;
    };
    const manager = (storage: WorkflowRunStorage, deliver: (run: WorkflowRunSummaryV1, result?: string) => unknown) => {
        const value = new WorkflowRunManager({ backend: backend(storage), emit: () => {}, deliver });
        managers.push(value);
        return value;
    };

    try {
        const result = { answer: 42 };
        const firstDirectory = await persist("persisted", result);
        const deliveries: unknown[] = [];
        await manager(new WorkflowRunStorage(root), (_run, value) => deliveries.push(value)).initialize(project);
        expect(deliveries).toEqual([JSON.stringify(result)]);
        expect(
            JSON.parse(await fs.promises.readFile(path.join(firstDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({
            delivered: true,
        });

        await manager(new WorkflowRunStorage(root), (_run, value) => deliveries.push(value)).initialize(project);
        expect(deliveries).toEqual([JSON.stringify(result)]);

        const claimedDirectory = await persist("abandoned-claim", "ready");
        expect(await storageA.claimDelivery(claimedDirectory)).toBe(true);
        const claimedDeliveries: unknown[] = [];
        await manager(new WorkflowRunStorage(root), (_run, value) => claimedDeliveries.push(value)).initialize(project);
        expect(claimedDeliveries).toEqual([JSON.stringify("ready")]);
        expect(
            JSON.parse(await fs.promises.readFile(path.join(claimedDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({ delivered: true });

        const corruptDirectory = await persist("corrupt", "unsafe");
        await fs.promises.writeFile(path.join(corruptDirectory, "launch.json"), "{");
        const beforeCorrupt = claimedDeliveries.length;
        const corruptRuns = await manager(new WorkflowRunStorage(root), (_run, value) =>
            claimedDeliveries.push(value),
        ).initialize(project);
        expect(corruptRuns.find(({ id }) => id === "corrupt")?.error).toContain("Stored workflow is corrupt");
        expect(claimedDeliveries).toHaveLength(beforeCorrupt);
        expect(
            await fs.promises.stat(path.join(corruptDirectory, "delivery.json")).catch(() => undefined),
        ).toBeUndefined();

        const retryDirectory = await persist("retry", "eventual");
        const failing = manager(new WorkflowRunStorage(root), async (summary) => {
            if (summary.id === "retry") throw new Error("delivery unavailable");
        });
        await expect(failing.initialize(project)).rejects.toThrow("delivery unavailable");
        expect(
            await fs.promises.stat(path.join(retryDirectory, "delivery.json")).catch(() => undefined),
        ).toBeUndefined();

        const retried: unknown[] = [];
        await manager(new WorkflowRunStorage(root), (summary, value) => {
            if (summary.id === "retry") retried.push(value);
        }).initialize(project);
        expect(retried).toEqual([JSON.stringify("eventual")]);
        expect(
            JSON.parse(await fs.promises.readFile(path.join(retryDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({
            delivered: true,
        });
    } finally {
        await Promise.allSettled(managers.map((value) => value.shutdown()));
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
