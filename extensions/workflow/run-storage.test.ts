import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkflowRunStorage } from "./run-storage.js";

const summary: any = {
    schema: "pi.workflow",
    version: 1,
    id: "run-1",
    name: "x",
    sessionId: "s",
    cwd: "",
    status: "running",
    phases: [],
    agents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
    recentActivity: [],
    updatedAt: 1,
};
test("durably stores immutable launch, fsynced completions, snapshots and delivery claims", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-storage-")),
        project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    summary.cwd = project;
    try {
        const directory = await storage.create(
            project,
            "run-1",
            { script: "return 1", args: { x: 1 }, policy: {}, roles: [], models: [], limits: summary.limits },
            summary,
        );
        await storage.complete(directory, "agent-1", { ok: true });
        const [run] = await storage.discover(project);
        expect(run?.launch.script).toBe("return 1");
        expect(run?.completions.get("agent-1")).toEqual({ ok: true });
        expect(await storage.claimDelivery(directory)).toBe(true);
        expect(await storage.claimDelivery(directory)).toBe(false);
        await storage.markDelivered(directory);
        expect((await storage.discover(project))[0]?.delivery.delivered).toBe(true);
        expect((await fs.promises.stat(directory)).mode & 0o077).toBe(0);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
test("fails closed on truncated journals and symlink artifacts", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-corrupt-")),
        project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    summary.cwd = project;
    try {
        const d = await storage.create(
            project,
            "run-1",
            { script: "return 1", policy: {}, roles: [], models: [], limits: {} },
            summary,
        );
        await fs.promises.appendFile(path.join(d, "journal.jsonl"), "{");
        await expect(storage.discover(project)).rejects.toThrow("Truncated");
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
