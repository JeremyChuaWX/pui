import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowRunV1, type WorkflowRunSummaryV1 } from "./protocol.js";
import { findRepositoryRoot } from "./storage.js";
import type { OwnedWorktree } from "./worktree.js";

const MAX_ARTIFACT = 16 * 1024 * 1024;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
export interface ImmutableRunLaunch {
    name?: string;
    sessionId?: string;
    cwd?: string;
    script: string;
    args?: unknown;
    policy: unknown;
    roles: readonly string[];
    models: readonly string[];
    limits: unknown;
    parentRunId?: string;
}
export interface JournalCompletion {
    version: 1;
    type: "completed";
    operation: string;
    value: unknown;
    at: number;
}
export interface DeliveryState {
    delivered?: boolean;
    claimed?: boolean;
    claimedAt?: number;
    owner?: string;
}
export interface StoredRun {
    id: string;
    directory: string;
    launch: ImmutableRunLaunch & { name: string; sessionId: string; cwd: string };
    snapshot: WorkflowRunSummaryV1;
    completions: Map<string, unknown>;
    worktrees: Map<string, OwnedWorktree>;
    delivery: DeliveryState;
    result?: string;
    corrupt?: boolean;
}

function json(value: unknown): string {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Workflow artifact must be JSON-compatible.");
    if (Buffer.byteLength(text) > MAX_ARTIFACT) throw new Error("Workflow artifact exceeds 16 MiB.");
    return text;
}
async function syncDirectory(directory: string) {
    const handle = await fs.promises.open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
async function atomic(file: string, value: unknown) {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
        const handle = await fs.promises.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(json(value));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.rename(temp, file);
        await syncDirectory(path.dirname(file));
    } finally {
        await fs.promises.rm(temp, { force: true });
    }
}
async function boundedJson(file: string): Promise<any> {
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_ARTIFACT)
        throw new Error(`Unsafe or oversized workflow artifact: ${file}`);
    try {
        return JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch {
        throw new Error(`Corrupt workflow artifact: ${file}`);
    }
}
function projectHash(cwd: string) {
    return createHash("sha256").update(cwd).digest("hex");
}

/** Injectible durable storage. All paths are private and outside the checkout by default. */
export class WorkflowRunStorage {
    readonly root: string;
    private readonly instanceToken = crypto.randomUUID();
    constructor(root = path.join(os.homedir(), ".pi", "agent", "workflow-runs")) {
        this.root = path.resolve(root);
    }
    private async project(cwd: string, create = false) {
        const canonical = await fs.promises.realpath(cwd),
            repository = (await findRepositoryRoot(canonical)) ?? canonical,
            directory = path.join(this.root, projectHash(await fs.promises.realpath(repository)));
        if (create) {
            const parent = path.dirname(this.root);
            const parentStat = await fs.promises.lstat(parent).catch(() => undefined);
            if (parentStat?.isSymbolicLink()) throw new Error("Unsafe workflow storage parent.");
            await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
            const rootStat = await fs.promises.lstat(this.root);
            if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unsafe workflow storage root.");
            await fs.promises.mkdir(directory, { mode: 0o700 });
            await fs.promises.chmod(this.root, 0o700);
            await fs.promises.chmod(directory, 0o700);
        }
        return directory;
    }
    async create(cwd: string, id: string, launch: ImmutableRunLaunch, snapshot: WorkflowRunSummaryV1): Promise<string> {
        if (!RUN_ID.test(id)) throw new Error("Invalid workflow run id.");
        const project = await this.project(cwd, true),
            directory = path.join(project, id);
        await fs.promises.mkdir(directory, { mode: 0o700 });
        await fs.promises.chmod(directory, 0o700);
        const files: [string, unknown][] = [
            ["workflow.js", launch.script],
            ["args.json", launch.args ?? null],
            [
                "launch.json",
                {
                    version: 1,
                    name: launch.name,
                    sessionId: launch.sessionId,
                    cwd: launch.cwd,
                    policy: launch.policy,
                    roles: launch.roles,
                    models: launch.models,
                    limits: launch.limits,
                    parentRunId: launch.parentRunId,
                },
            ],
        ];
        for (const [name, value] of files) {
            const handle = await fs.promises.open(path.join(directory, name), "wx", 0o600);
            try {
                await handle.writeFile(name === "workflow.js" ? String(value) : json(value));
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
        const journal = await fs.promises.open(path.join(directory, "journal.jsonl"), "wx", 0o600);
        await journal.sync();
        await journal.close();
        await atomic(path.join(directory, "snapshot.json"), snapshot);
        await syncDirectory(directory);
        return directory;
    }
    async snapshot(directory: string, snapshot: WorkflowRunSummaryV1) {
        await this.assertDirectory(directory);
        // A stale host must not overwrite the durable terminal state produced by recovery.
        if (await fs.promises.stat(path.join(directory, "summary.json")).catch(() => undefined)) return;
        await atomic(path.join(directory, "snapshot.json"), snapshot);
    }
    async complete(directory: string, operation: string, value: unknown, at = Date.now()) {
        if (!operation || operation.length > 1024) throw new Error("Invalid workflow operation identity.");
        const line = `${json({ version: 1, type: "completed", operation, value, at } satisfies JournalCompletion)}\n`;
        const file = path.join(await this.assertDirectory(directory), "journal.jsonl"),
            handle = await fs.promises.open(file, "a", 0o600);
        try {
            await handle.write(line);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    async worktree(directory: string, operation: string, owned: OwnedWorktree | null, at = Date.now()) {
        if (!RUN_ID.test(operation)) throw new Error("Invalid worktree operation identity.");
        const line = `${json({ version: 1, type: owned ? "worktree-owned" : "worktree-released", operation, owned, at })}\n`;
        const handle = await fs.promises.open(
            path.join(await this.assertDirectory(directory), "journal.jsonl"),
            "a",
            0o600,
        );
        try {
            await handle.write(line);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    async terminal(directory: string, result: unknown, summary: WorkflowRunSummaryV1) {
        await this.assertDirectory(directory);
        // Recovery and the dying host can settle concurrently; the first durable terminal wins.
        const summaryFile = path.join(directory, "summary.json");
        if (await fs.promises.stat(summaryFile).catch(() => undefined)) return;
        await atomic(path.join(directory, "result.json"), result);
        await atomic(summaryFile, summary);
    }
    async claimDelivery(directory: string): Promise<boolean> {
        await this.assertDirectory(directory);
        const marker = path.join(directory, "delivery.json");
        try {
            const h = await fs.promises.open(marker, "wx", 0o600);
            await h.writeFile(json({ version: 1, claimed: true, claimedAt: Date.now(), owner: this.instanceToken }));
            await h.sync();
            await h.close();
            await syncDirectory(directory);
            return true;
        } catch (e: any) {
            if (e?.code === "EEXIST") {
                const state = await boundedJson(marker);
                // A claim owned by another backend process is abandoned on startup/recovery.
                // The same instance still suppresses duplicate concurrent delivery attempts.
                if (state?.claimed && !state.delivered && state.owner !== this.instanceToken) {
                    await fs.promises.rm(marker, { force: true });
                    return this.claimDelivery(directory);
                }
                return false;
            }
            throw e;
        }
    }
    async markDelivered(directory: string) {
        await atomic(path.join(await this.assertDirectory(directory), "delivery.json"), {
            version: 1,
            delivered: true,
        });
    }
    async releaseClaim(directory: string) {
        const file = path.join(await this.assertDirectory(directory), "delivery.json");
        const state = await boundedJson(file).catch(() => undefined);
        if (state?.claimed && !state.delivered) await fs.promises.rm(file, { force: true });
    }
    async discover(cwd: string): Promise<StoredRun[]> {
        const project = await this.project(cwd);
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(project, { withFileTypes: true });
        } catch (e: any) {
            if (e?.code === "ENOENT") return [];
            throw e;
        }
        const runs: StoredRun[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
            try {
                const directory = await this.assertDirectory(path.join(project, entry.name));
                const scriptStat = await fs.promises.lstat(path.join(directory, "workflow.js"));
                if (scriptStat.isSymbolicLink() || scriptStat.size > MAX_ARTIFACT)
                    throw new Error(`Unsafe workflow source in ${entry.name}.`);
                const script = await fs.promises.readFile(path.join(directory, "workflow.js"), "utf8"),
                    args = await boundedJson(path.join(directory, "args.json")),
                    meta = await boundedJson(path.join(directory, "launch.json")),
                    rawSnapshot = await boundedJson(path.join(directory, "summary.json")).catch((e: any) =>
                        e?.code === "ENOENT" ? boundedJson(path.join(directory, "snapshot.json")) : Promise.reject(e),
                    ),
                    snapshot = parseWorkflowRunV1(rawSnapshot);
                if (!snapshot || snapshot.id !== entry.name)
                    throw new Error(`Invalid workflow snapshot in ${entry.name}.`);
                const journalStat = await fs.promises.lstat(path.join(directory, "journal.jsonl"));
                if (journalStat.isSymbolicLink() || journalStat.size > MAX_ARTIFACT)
                    throw new Error(`Unsafe workflow journal in ${entry.name}.`);
                const raw = await fs.promises.readFile(path.join(directory, "journal.jsonl"), "utf8");
                if (raw && !raw.endsWith("\n")) throw new Error(`Truncated workflow journal in ${entry.name}.`);
                const completions = new Map<string, unknown>(),
                    worktrees = new Map<string, OwnedWorktree>();
                for (const line of raw.split("\n").filter(Boolean)) {
                    let item: any;
                    try {
                        item = JSON.parse(line);
                    } catch {
                        throw new Error(`Corrupt workflow journal in ${entry.name}.`);
                    }
                    if (
                        item?.version !== 1 ||
                        typeof item.operation !== "string" ||
                        !RUN_ID.test(item.operation) ||
                        !Number.isFinite(item.at)
                    )
                        throw new Error(`Invalid workflow journal in ${entry.name}.`);
                    if (item.type === "completed") {
                        if (completions.has(item.operation))
                            throw new Error(`Invalid workflow journal in ${entry.name}.`);
                        json(item.value);
                        completions.set(item.operation, item.value);
                    } else if (item.type === "worktree-owned") {
                        if (
                            worktrees.has(item.operation) ||
                            !item.owned ||
                            typeof item.owned.cwd !== "string" ||
                            typeof item.owned.branch !== "string" ||
                            typeof item.owned.ref !== "string"
                        )
                            throw new Error(`Invalid workflow journal in ${entry.name}.`);
                        worktrees.set(item.operation, item.owned);
                    } else if (item.type === "worktree-released") worktrees.delete(item.operation);
                    else throw new Error(`Invalid workflow journal in ${entry.name}.`);
                }
                const delivery = await boundedJson(path.join(directory, "delivery.json")).catch((e: any) =>
                    e?.code === "ENOENT" ? {} : Promise.reject(e),
                );
                if (
                    delivery.version !== undefined &&
                    (delivery.version !== 1 ||
                        (delivery.claimed !== undefined && typeof delivery.claimed !== "boolean") ||
                        (delivery.delivered !== undefined && typeof delivery.delivered !== "boolean"))
                )
                    throw new Error(`Invalid workflow delivery state in ${entry.name}.`);
                runs.push({
                    id: entry.name,
                    directory,
                    launch: {
                        name: meta.name ?? snapshot.name,
                        sessionId: meta.sessionId ?? snapshot.sessionId,
                        cwd: meta.cwd ?? snapshot.cwd,
                        script,
                        args,
                        policy: meta.policy,
                        roles: meta.roles ?? [],
                        models: meta.models ?? [],
                        limits: meta.limits,
                        parentRunId: meta.parentRunId,
                    },
                    snapshot,
                    completions,
                    worktrees,
                    delivery,
                    ...(snapshot.status === "succeeded"
                        ? { result: json(await boundedJson(path.join(directory, "result.json"))) }
                        : {}),
                });
            } catch (error) {
                const timestamp = Date.now();
                runs.push({
                    id: entry.name,
                    directory: path.join(project, entry.name),
                    launch: {
                        name: "Corrupt workflow",
                        sessionId: "unknown",
                        cwd: await fs.promises.realpath(cwd),
                        script: "",
                        policy: {},
                        roles: [],
                        models: [],
                        limits: {},
                    },
                    snapshot: {
                        schema: "pi.workflow",
                        version: 1,
                        id: entry.name,
                        name: "Corrupt workflow",
                        sessionId: "unknown",
                        cwd: await fs.promises.realpath(cwd),
                        status: "failed",
                        phases: [],
                        agents: [],
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
                        limits: { maxConcurrency: 1, maxAgents: 1, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
                        recentActivity: [],
                        updatedAt: timestamp,
                        endedAt: timestamp,
                        error: `Stored workflow is corrupt and was not executed: ${error instanceof Error ? error.message : String(error)}`.slice(
                            0,
                            2000,
                        ),
                    },
                    completions: new Map(),
                    worktrees: new Map(),
                    delivery: {},
                    corrupt: true,
                });
            }
        }
        return runs;
    }
    private async assertDirectory(directory: string) {
        const resolved = path.resolve(directory),
            rel = path.relative(this.root, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Workflow artifact escapes storage root.");
        const stat = await fs.promises.lstat(resolved);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe workflow run directory.");
        const canonicalRoot = await fs.promises.realpath(this.root),
            canonical = await fs.promises.realpath(resolved);
        if (path.relative(canonicalRoot, canonical).startsWith(".."))
            throw new Error("Workflow artifact escapes canonical storage root.");
        return resolved;
    }
}
