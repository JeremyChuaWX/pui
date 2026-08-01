import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
        const source = "// approved source\nexport default async function workflow() { return { value: 'π' }; }\n";
        const directory = await storage.create(
            project,
            "run-1",
            {
                script: source,
                entrypoint: "function",
                args: { x: 1 },
                policy: {},
                roles: [],
                models: [],
                limits: summary.limits,
            },
            summary,
        );
        expect(await fs.promises.readFile(path.join(directory, "workflow.ts"), "utf8")).toBe(source);
        await expect(fs.promises.lstat(path.join(directory, "workflow.js"))).rejects.toMatchObject({ code: "ENOENT" });
        await storage.complete(directory, "agent-1", { ok: true });
        await expect(storage.complete(directory, "agent/2", null)).rejects.toThrow("Invalid workflow operation");
        await expect(storage.complete(directory, `a${"x".repeat(256)}`, null)).rejects.toThrow(
            "Invalid workflow operation",
        );
        const [run] = await storage.discover(project);
        expect(run?.launch.script).toBe(source);
        expect(run?.launch.entrypoint).toBe("function");
        expect(run?.completions.get("agent-1")).toEqual({ ok: true });
        expect(await storage.claimDelivery(directory)).toBe(true);
        expect(await storage.claimDelivery(directory)).toBe(false);
        await storage.markDelivered(directory);
        await fs.promises.writeFile(path.join(directory, "journal.jsonl"), "historical artifact need not be parsed");
        expect(await storage.discover(project)).toEqual([]);
        expect((await fs.promises.stat(directory)).mode & 0o077).toBe(0);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
test("discovers workflow.ts sources written by prior versions", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-typescript-source-")),
        project = path.join(temp, "project"),
        storage = new WorkflowRunStorage(path.join(temp, "runs"));
    await fs.promises.mkdir(project);
    try {
        const source = "return 'legacy';\n",
            directory = await storage.create(
                project,
                "run-1",
                { script: source, policy: {}, roles: [], models: [], limits: {} },
                makeSummary(project),
            );
        await fs.promises.rename(path.join(directory, "workflow.js"), path.join(directory, "workflow.ts"));

        const [stored] = await storage.discover(project);
        expect(stored?.corrupt).toBeUndefined();
        expect(stored?.launch.script).toBe(source);
        expect(stored?.launch.entrypoint).toBe("script");
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("fails closed when both workflow source filenames exist", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-ambiguous-source-")),
        project = path.join(temp, "project"),
        storage = new WorkflowRunStorage(path.join(temp, "runs"));
    await fs.promises.mkdir(project);
    try {
        const directory = await storage.create(
            project,
            "run-1",
            { script: "return 'typescript';", policy: {}, roles: [], models: [], limits: {} },
            makeSummary(project),
        );
        await fs.promises.writeFile(path.join(directory, "workflow.ts"), "return 'typescript';");

        const [stored] = await storage.discover(project);
        expect(stored?.corrupt).toBe(true);
        expect(stored?.snapshot.error).toContain("Ambiguous");
        expect(stored?.launch.script).toBe("");
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
        const marker = path.join(directory, "delivery.json"),
            old = new Date(Date.now() - 120_000);
        await fs.promises.writeFile(
            marker,
            JSON.stringify({
                version: 1,
                claimed: true,
                claimedAt: old.getTime(),
                owner: "stopped-host",
                pid: process.pid,
                host: os.hostname(),
            }),
        );
        await fs.promises.utimes(marker, old, old);
        const malformedRelease = path.join(
            directory,
            `.delivery.release-${createHash("sha256").update("stopped-host").digest("hex")}.json`,
        );
        await fs.promises.writeFile(malformedRelease, "{");
        expect(await second.recoverDeliveryClaim(directory, 1_000)).toBe(true);
        await second.releaseClaim(directory);
        await first.terminal(directory, "done", makeSummary(project, { status: "succeeded", endedAt: Date.now() }));

        await fs.promises.writeFile(marker, "{");
        await fs.promises.utimes(marker, old, old);
        const [stored] = await second.discover(project);
        expect(stored?.corrupt).toBeUndefined();
        expect(stored?.snapshot.status).toBe("succeeded");
        expect(await second.claimDelivery(directory)).toBe(false);
        const recovery = path.join(directory, "delivery.recovery.json");
        await fs.promises.rename(marker, recovery);
        expect(await second.recoverDeliveryClaim(directory, 1_000)).toBe(true);
        await expect(fs.promises.lstat(recovery)).rejects.toMatchObject({ code: "ENOENT" });

        await second.releaseClaim(directory);
        await fs.promises.writeFile(marker, "{");
        await fs.promises.writeFile(recovery, JSON.stringify({ version: 1, claimed: true, owner: "stale" }));
        await fs.promises.utimes(marker, old, old);
        expect(await second.recoverDeliveryClaim(directory, 1_000)).toBe(true);
        await expect(fs.promises.lstat(recovery)).rejects.toMatchObject({ code: "ENOENT" });

        await second.releaseClaim(directory);
        const replacementOwner = new WorkflowRunStorage(root);
        expect(await replacementOwner.recoverDeliveryClaim(directory, 3_600_000)).toBe(true);
        const replacement = JSON.parse(await fs.promises.readFile(marker, "utf8"));
        await second.releaseClaim(directory);
        expect(JSON.parse(await fs.promises.readFile(marker, "utf8"))).toEqual(replacement);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("keeps the canonical claim occupied throughout recovery", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-run-claim-race-")),
        project = path.join(temp, "project"),
        root = path.join(temp, "runs");
    await fs.promises.mkdir(project);
    const recovering = new WorkflowRunStorage(root),
        contender = new WorkflowRunStorage(root),
        originalLink = fs.promises.link;
    let concurrentClaim: boolean | undefined;
    let concurrentRecovery: boolean | undefined;
    try {
        const directory = await recovering.create(
            project,
            "run-1",
            { script: "", policy: {}, roles: [], models: [], limits: {} },
            makeSummary(project),
        );
        expect(await recovering.claimDelivery(directory)).toBe(true);
        await recovering.releaseClaim(directory);
        const recovery = path.join(directory, "delivery.recovery.json");
        fs.promises.link = async (existingPath, newPath) => {
            await originalLink(existingPath, newPath);
            if (newPath === recovery) {
                concurrentClaim = await contender.claimDelivery(directory);
                concurrentRecovery = await recovering.recoverDeliveryClaim(directory);
            }
        };

        expect(await contender.recoverDeliveryClaim(directory)).toBe(true);
        expect(concurrentClaim).toBe(false);
        expect(concurrentRecovery).toBe(false);

        await contender.releaseClaim(directory);
        const token = crypto.randomUUID(),
            lock = path.join(directory, "delivery.recovery.lock"),
            lockOwner = path.join(lock, `owner-${token}`),
            expired = Date.now() - 60_000;
        await fs.promises.mkdir(lockOwner, { recursive: true });
        await fs.promises.writeFile(
            path.join(lockOwner, "owner.json"),
            JSON.stringify({ token, pid: process.pid, host: "interrupted-host", startedAt: expired }),
        );
        await fs.promises.utimes(lock, new Date(expired), new Date(expired));
        await originalLink(path.join(directory, "delivery.json"), recovery);
        expect(await recovering.recoverDeliveryClaim(directory)).toBe(true);
        await expect(fs.promises.lstat(recovery)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.promises.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        fs.promises.link = originalLink;
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
