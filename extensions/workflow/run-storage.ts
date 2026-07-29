import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowRunV1, type WorkflowRunSummaryV1 } from "./protocol.js";
import { inferDirectoryBoundary, safeDirectory } from "./safe-directory.js";
import { findRepositoryRoot } from "./storage.js";
import type { OwnedWorktree } from "./worktree.js";

const MAX_ARTIFACT = 16 * 1024 * 1024;
const MAX_TERMINAL_ARTIFACT = MAX_ARTIFACT * 2 + 1_024;
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
    pid?: number;
    host?: string;
}
interface TerminalState {
    version: 1;
    result: unknown;
    summary: WorkflowRunSummaryV1;
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

function json(value: unknown, maximum = MAX_ARTIFACT): string {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Workflow artifact must be JSON-compatible.");
    if (Buffer.byteLength(text) > maximum) throw new Error("Workflow artifact exceeds its size limit.");
    return text;
}
async function syncDirectory(directory: string) {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(directory, "r");
        await handle.sync();
    } catch (error) {
        // Windows does not consistently permit opening or syncing directory handles.
        if (process.platform !== "win32" || !["EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
    } finally {
        await handle?.close();
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
async function exclusive(file: string, value: unknown, maximum = MAX_ARTIFACT): Promise<boolean> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
        const handle = await fs.promises.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(json(value, maximum));
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await fs.promises.link(temp, file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
            throw error;
        }
        await syncDirectory(path.dirname(file));
        return true;
    } finally {
        await fs.promises.rm(temp, { force: true });
    }
}
async function boundedJson<T = unknown>(file: string, maximum = MAX_ARTIFACT): Promise<T> {
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum)
        throw new Error(`Unsafe or oversized workflow artifact: ${file}`);
    try {
        return JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch {
        throw new Error(`Corrupt workflow artifact: ${file}`);
    }
}
async function readDelivery(
    file: string,
): Promise<{ value: DeliveryState & { version?: number }; malformed: boolean }> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, malformed: false };
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_ARTIFACT)
        throw new Error(`Unsafe or oversized workflow artifact: ${file}`);
    const text = await fs.promises.readFile(file, "utf8");
    try {
        return { value: JSON.parse(text), malformed: false };
    } catch {
        // An older claimant could crash between exclusive creation and its write. Keep the run
        // discoverable so the explicit startup recovery path can quarantine this marker safely.
        return { value: { claimed: true }, malformed: true };
    }
}
function projectHash(cwd: string) {
    return createHash("sha256").update(cwd).digest("hex");
}
function isProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
function blocksDeliveryRecovery(
    state: DeliveryState | undefined,
    modifiedAt: number,
    staleAfterMs: number,
    instanceToken: string,
) {
    if (state?.delivered || state?.owner === instanceToken) return true;
    const staleWindow = Math.max(0, staleAfterMs),
        recordedClaim = state?.claimedAt,
        claimedAt =
            typeof recordedClaim === "number" && Number.isFinite(recordedClaim)
                ? Math.max(modifiedAt, recordedClaim)
                : modifiedAt,
        age = Math.max(0, Date.now() - claimedAt);
    if (age < staleWindow) return true;
    const livePidGrace = Math.max(30_000, staleWindow * 2);
    return age < livePidGrace && state?.host === os.hostname() && state.pid !== undefined && isProcessAlive(state.pid);
}
function deliveryReleaseFile(directory: string, owner: string): string {
    return path.join(directory, `.delivery.release-${createHash("sha256").update(owner).digest("hex")}.json`);
}
async function hasDeliveryRelease(directory: string, owner: string | undefined): Promise<boolean> {
    if (!owner) return false;
    const file = deliveryReleaseFile(directory, owner);
    try {
        const release = await boundedJson<{ version?: unknown; owner?: unknown }>(file, 4_096);
        return release.version === 1 && release.owner === owner;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Injectible durable storage. All paths are private and outside the checkout by default. */
export class WorkflowRunStorage {
    readonly root: string;
    private readonly instanceToken = crypto.randomUUID();
    private readonly trustedBoundary?: string;
    constructor(root?: string, trustedBoundary?: string) {
        this.root = path.resolve(root ?? path.join(os.homedir(), ".pi", "agent", "workflow-runs"));
        this.trustedBoundary = trustedBoundary ?? (root === undefined ? os.homedir() : undefined);
    }
    private async boundary() {
        return this.trustedBoundary ?? inferDirectoryBoundary(this.root);
    }
    private async project(cwd: string, create = false) {
        const canonical = await fs.promises.realpath(cwd),
            repository = (await findRepositoryRoot(canonical)) ?? canonical,
            directory = path.join(this.root, projectHash(await fs.promises.realpath(repository)));
        const boundary = await this.boundary();
        if (create) {
            const root = await safeDirectory(this.root, boundary, true),
                project = await safeDirectory(directory, boundary, true);
            await fs.promises.chmod(root, 0o700);
            await fs.promises.chmod(project, 0o700);
            return project;
        }
        try {
            return await safeDirectory(directory, boundary, false);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const root = await safeDirectory(this.root, boundary, false).catch((rootError: NodeJS.ErrnoException) => {
                if (rootError.code === "ENOENT") return this.root;
                throw rootError;
            });
            return path.join(root, path.basename(directory));
        }
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
        if (!RUN_ID.test(operation)) throw new Error("Invalid workflow operation identity.");
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
        directory = await this.assertDirectory(directory);
        const expectedId = path.basename(directory),
            proposedSummary = parseWorkflowRunV1(summary);
        if (
            !proposedSummary ||
            proposedSummary.id !== expectedId ||
            !["succeeded", "failed", "cancelled"].includes(proposedSummary.status)
        )
            throw new Error("Invalid terminal workflow state.");
        const summaryFile = path.join(directory, "summary.json");
        // Compatibility with runs settled before terminal.json was introduced.
        if (await fs.promises.stat(summaryFile).catch(() => undefined)) return;
        json(result);
        json(summary);
        const stateFile = path.join(directory, "terminal.json"),
            proposed = { version: 1, result, summary } satisfies TerminalState,
            won = await exclusive(stateFile, proposed, MAX_TERMINAL_ARTIFACT),
            state = won ? proposed : await boundedJson<TerminalState>(stateFile, MAX_TERMINAL_ARTIFACT),
            parsed = state?.version === 1 ? parseWorkflowRunV1(state.summary) : undefined;
        if (!parsed || parsed.id !== expectedId || !["succeeded", "failed", "cancelled"].includes(parsed.status))
            throw new Error("Invalid terminal workflow state.");
        // The exclusive bundle is the durable winner. Publishing result first ensures readers can
        // never observe the winning summary without its matching result, and retries repair crashes.
        await atomic(path.join(directory, "result.json"), state.result);
        await atomic(summaryFile, state.summary);
    }
    async claimDelivery(directory: string): Promise<boolean> {
        directory = await this.assertDirectory(directory);
        const marker = path.join(directory, "delivery.json"),
            temp = path.join(directory, `.delivery.${this.instanceToken}.${crypto.randomUUID()}.tmp`);
        try {
            const handle = await fs.promises.open(temp, "wx", 0o600);
            try {
                await handle.writeFile(
                    json({
                        version: 1,
                        claimed: true,
                        claimedAt: Date.now(),
                        owner: this.instanceToken,
                        pid: process.pid,
                        host: os.hostname(),
                    }),
                );
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.promises.link(temp, marker);
            await syncDirectory(directory);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
            throw error;
        } finally {
            await fs.promises.rm(temp, { force: true });
        }
    }
    private async finishDeliveryRecovery(directory: string, recovery: string, staleAfterMs: number): Promise<boolean> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.lstat(recovery);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.claimDelivery(directory);
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_ARTIFACT)
            throw new Error(`Unsafe or oversized workflow artifact: ${recovery}`);
        const state = await boundedJson<DeliveryState>(recovery).catch(() => undefined),
            marker = path.join(directory, "delivery.json"),
            released = await hasDeliveryRelease(directory, state?.owner);
        let durableReplacement = false;
        try {
            if (!released && blocksDeliveryRecovery(state, stat.mtimeMs, staleAfterMs, this.instanceToken)) {
                try {
                    await fs.promises.link(recovery, marker);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                }
                await syncDirectory(directory);
                durableReplacement = true;
                return false;
            }
            const claimed = await this.claimDelivery(directory);
            if (claimed) {
                durableReplacement = true;
                return true;
            }
            durableReplacement = await fs.promises
                .lstat(marker)
                .then((value) => value.isFile() && !value.isSymbolicLink())
                .catch(() => false);
            return false;
        } finally {
            if (durableReplacement) {
                await fs.promises.rm(recovery, { force: true });
                if (released && state?.owner)
                    await fs.promises.rm(deliveryReleaseFile(directory, state.owner), { force: true });
                await syncDirectory(directory);
            }
        }
    }
    /** Explicitly recover a stale or interrupted claim; normal claims never steal ownership. */
    async recoverDeliveryClaim(directory: string, staleAfterMs = 30_000): Promise<boolean> {
        directory = await this.assertDirectory(directory);
        const marker = path.join(directory, "delivery.json"),
            recovery = path.join(directory, "delivery.recovery.json");
        let initial: fs.Stats;
        try {
            initial = await fs.promises.lstat(marker);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return this.finishDeliveryRecovery(directory, recovery, staleAfterMs);
            throw error;
        }
        if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_ARTIFACT)
            throw new Error(`Unsafe or oversized workflow artifact: ${marker}`);

        const leftover = await fs.promises.lstat(recovery).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        if (leftover) {
            if (leftover.isSymbolicLink() || !leftover.isFile() || leftover.size > MAX_ARTIFACT)
                throw new Error(`Unsafe or oversized workflow artifact: ${recovery}`);
            const canonical = await boundedJson<DeliveryState>(marker).catch(() => undefined);
            if (canonical && !canonical.claimed && !canonical.delivered)
                throw new Error("Invalid workflow delivery state.");
            await fs.promises.rm(recovery, { force: true });
            await syncDirectory(directory);
        }

        const initialState = await boundedJson<DeliveryState>(marker).catch(() => undefined),
            released = await hasDeliveryRelease(directory, initialState?.owner);
        if (!released && blocksDeliveryRecovery(initialState, initial.mtimeMs, staleAfterMs, this.instanceToken))
            return false;
        try {
            await fs.promises.rename(marker, recovery);
            await syncDirectory(directory);
        } catch (error) {
            if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        return this.finishDeliveryRecovery(directory, recovery, staleAfterMs);
    }
    async markDelivered(directory: string) {
        const marker = path.join(await this.assertDirectory(directory), "delivery.json"),
            state = await boundedJson<DeliveryState>(marker);
        if (state.delivered) return;
        if (!state.claimed || state.owner !== this.instanceToken)
            throw new Error("Workflow delivery claim is not owned by this backend.");
        await atomic(marker, { version: 1, delivered: true });
    }
    async releaseClaim(directory: string) {
        directory = await this.assertDirectory(directory);
        const state = await boundedJson<DeliveryState>(path.join(directory, "delivery.json")).catch(() => undefined);
        if (state?.claimed && !state.delivered && state.owner === this.instanceToken)
            await atomic(deliveryReleaseFile(directory, this.instanceToken), {
                version: 1,
                owner: this.instanceToken,
                releasedAt: Date.now(),
            });
    }
    async discover(cwd: string): Promise<StoredRun[]> {
        const project = await this.project(cwd);
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(project, { withFileTypes: true });
        } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
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
                    meta = await boundedJson<
                        Partial<Omit<ImmutableRunLaunch, "script" | "args">> & {
                            name?: string;
                            sessionId?: string;
                            cwd?: string;
                        }
                    >(path.join(directory, "launch.json")),
                    terminal = await boundedJson<TerminalState>(
                        path.join(directory, "terminal.json"),
                        MAX_TERMINAL_ARTIFACT,
                    ).catch((error: unknown) => {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                        throw error;
                    });
                if (terminal) {
                    const terminalSummary = terminal.version === 1 ? parseWorkflowRunV1(terminal.summary) : undefined;
                    if (
                        !terminalSummary ||
                        terminalSummary.id !== entry.name ||
                        !["succeeded", "failed", "cancelled"].includes(terminalSummary.status)
                    )
                        throw new Error(`Invalid terminal workflow state in ${entry.name}.`);
                    if (!(await fs.promises.stat(path.join(directory, "summary.json")).catch(() => undefined))) {
                        await atomic(path.join(directory, "result.json"), terminal.result);
                        await atomic(path.join(directory, "summary.json"), terminal.summary);
                    }
                }
                const rawSnapshot = terminal
                        ? terminal.summary
                        : await boundedJson(path.join(directory, "summary.json")).catch((e: unknown) =>
                              (e as NodeJS.ErrnoException).code === "ENOENT"
                                  ? boundedJson(path.join(directory, "snapshot.json"))
                                  : Promise.reject(e),
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
                    let item: {
                        version?: unknown;
                        type?: unknown;
                        operation?: unknown;
                        value?: unknown;
                        at?: unknown;
                        owned?: Partial<OwnedWorktree>;
                    };
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
                        worktrees.set(item.operation, item.owned as OwnedWorktree);
                    } else if (item.type === "worktree-released") worktrees.delete(item.operation);
                    else throw new Error(`Invalid workflow journal in ${entry.name}.`);
                }
                const { value: delivery, malformed: malformedDelivery } = await readDelivery(
                    path.join(directory, "delivery.json"),
                );
                if (
                    !malformedDelivery &&
                    delivery.version !== undefined &&
                    (delivery.version !== 1 ||
                        (delivery.claimed !== undefined && typeof delivery.claimed !== "boolean") ||
                        (delivery.delivered !== undefined && typeof delivery.delivered !== "boolean") ||
                        (delivery.claimedAt !== undefined && !Number.isFinite(delivery.claimedAt)) ||
                        (delivery.owner !== undefined && typeof delivery.owner !== "string") ||
                        (delivery.pid !== undefined && (!Number.isInteger(delivery.pid) || delivery.pid <= 0)) ||
                        (delivery.host !== undefined && typeof delivery.host !== "string"))
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
            stat = await fs.promises.lstat(resolved);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe workflow run directory.");
        const canonicalRoot = await safeDirectory(this.root, await this.boundary(), false),
            canonical = await safeDirectory(resolved, canonicalRoot, false);
        if (path.relative(canonicalRoot, canonical).startsWith(".."))
            throw new Error("Workflow artifact escapes canonical storage root.");
        return canonical;
    }
}
