import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkflowRunStorage } from "./run-storage.js";

const makeSummary = (cwd: string, overrides: Record<string, unknown> = {}): any => ({
    schema: "pi.workflow",
    version: 1,
    id: "run-1",
    name: "x",
    sessionId: "s",
    cwd,
    status: "running",
    phases: [],
    agents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
    recentActivity: [],
    updatedAt: 1,
    ...overrides,
});
test("durably stores immutable launch, fsynced completions, snapshots and delivery claims", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-storage-")),
        project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    const storage = new WorkflowRunStorage(path.join(temp, "runs")),
        summary = makeSummary(project);
    try {
        const directory = await storage.create(
            project,
            "run-1",
            { script: "return 1", args: { x: 1 }, policy: {}, roles: [], models: [], limits: summary.limits },
            summary,
        );
        await storage.complete(directory, "agent-1", { ok: true });
        await expect(storage.complete(directory, "agent/2", null)).rejects.toThrow("Invalid workflow operation");
        await expect(storage.complete(directory, `a${"x".repeat(256)}`, null)).rejects.toThrow(
            "Invalid workflow operation",
        );
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
test("does not steal a competing live claim and explicitly recovers an interrupted claim", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-claims-")),
        project = path.join(temp, "project"),
        root = path.join(temp, "runs");
    await fs.promises.mkdir(project);
    const first = new WorkflowRunStorage(root),
        second = new WorkflowRunStorage(root);
    try {
        const directory = await first.create(
            project,
            "run-1",
            { script: "", policy: {}, roles: [], models: [], limits: {} },
            makeSummary(project),
        );
        expect(await first.claimDelivery(directory)).toBe(true);
        expect(await second.claimDelivery(directory)).toBe(false);
        expect(await second.recoverDeliveryClaim(directory, 0)).toBe(false);
        await first.releaseClaim(directory);
        await fs.promises.writeFile(
            path.join(directory, "delivery.json"),
            JSON.stringify({
                version: 1,
                claimed: true,
                claimedAt: Date.now(),
                owner: "stopped-host",
                pid: 2_147_483_647,
            }),
        );
        expect(await second.recoverDeliveryClaim(directory, 60_000)).toBe(true);
        await second.releaseClaim(directory);
        await first.terminal(directory, "done", makeSummary(project, { status: "succeeded", endedAt: Date.now() }));

        const marker = path.join(directory, "delivery.json");
        await fs.promises.writeFile(marker, "{");
        const old = new Date(Date.now() - 60_000);
        await fs.promises.utimes(marker, old, old);
        const [stored] = await second.discover(project);
        expect(stored?.corrupt).toBeUndefined();
        expect(stored?.snapshot.status).toBe("succeeded");
        expect(await second.claimDelivery(directory)).toBe(false);
        expect(await second.recoverDeliveryClaim(directory, 1_000)).toBe(true);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("publishes exactly one matching terminal result and summary under concurrency", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-terminal-")),
        project = path.join(temp, "project"),
        root = path.join(temp, "runs");
    await fs.promises.mkdir(project);
    const first = new WorkflowRunStorage(root),
        second = new WorkflowRunStorage(root);
    try {
        const directory = await first.create(
            project,
            "run-1",
            { script: "", policy: {}, roles: [], models: [], limits: {} },
            makeSummary(project),
        );
        await Promise.all([
            first.terminal(directory, { winner: "a" }, makeSummary(project, { status: "succeeded", winner: "a" })),
            second.terminal(directory, { winner: "b" }, makeSummary(project, { status: "succeeded", winner: "b" })),
        ]);
        let publishedSummary = JSON.parse(await fs.promises.readFile(path.join(directory, "summary.json"), "utf8"));
        let publishedResult = JSON.parse(await fs.promises.readFile(path.join(directory, "result.json"), "utf8"));
        expect(publishedResult.winner).toBe(publishedSummary.winner);

        await fs.promises.rm(path.join(directory, "summary.json"));
        await fs.promises.rm(path.join(directory, "result.json"));
        const recovered = (await second.discover(project))[0];
        publishedSummary = JSON.parse(await fs.promises.readFile(path.join(directory, "summary.json"), "utf8"));
        publishedResult = JSON.parse(await fs.promises.readFile(path.join(directory, "result.json"), "utf8"));
        expect(recovered?.snapshot).toEqual(publishedSummary);
        expect(publishedResult.winner).toBe(publishedSummary.winner);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("rejects symlinked storage ancestors and project directories", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-boundary-")),
        project = path.join(temp, "project"),
        outside = path.join(temp, "outside");
    await fs.promises.mkdir(project);
    await fs.promises.mkdir(outside);
    try {
        const linkedRoot = path.join(temp, ".pi", "agent", "runs");
        await fs.promises.symlink(outside, path.join(temp, ".pi"));
        await expect(
            new WorkflowRunStorage(linkedRoot, temp).create(
                project,
                "run-1",
                { script: "", policy: {}, roles: [], models: [], limits: {} },
                makeSummary(project),
            ),
        ).rejects.toThrow("Unsafe directory component");
        await fs.promises.rm(path.join(temp, ".pi"));

        const storage = new WorkflowRunStorage(path.join(temp, "runs"), temp);
        const directory = await storage.create(
            project,
            "run-1",
            { script: "", policy: {}, roles: [], models: [], limits: {} },
            makeSummary(project),
        );
        const hashedProject = path.dirname(directory);
        await fs.promises.rm(hashedProject, { recursive: true });
        await fs.promises.symlink(outside, hashedProject);
        await expect(
            storage.create(
                project,
                "run-2",
                { script: "", policy: {}, roles: [], models: [], limits: {} },
                makeSummary(project, { id: "run-2" }),
            ),
        ).rejects.toThrow("Unsafe directory component");
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("isolates a corrupt journal as a bounded failed diagnostic", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-corrupt-")),
        project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    try {
        const d = await storage.create(
            project,
            "run-1",
            { script: "return 1", policy: {}, roles: [], models: [], limits: {} },
            makeSummary(project),
        );
        await fs.promises.appendFile(path.join(d, "journal.jsonl"), "{");
        const [corrupt] = await storage.discover(project);
        expect(corrupt?.snapshot.status).toBe("failed");
        expect(corrupt?.snapshot.error).toContain("Truncated");
        expect(corrupt?.snapshot.error?.length).toBeLessThanOrEqual(2_000);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
