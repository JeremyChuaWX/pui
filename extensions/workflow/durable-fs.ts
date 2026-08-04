import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared durable-filesystem primitives for the workflow extension's cross-process state: the
 * approval store and the run store. Everything here is crash-safety- and security-sensitive;
 * callers choose policies (stale windows, retry budgets, steal rules) but share one implementation
 * of the mkdir-candidate → owner.json → rename lock protocol and the atomic-write idioms.
 */

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export async function syncDirectory(directory: string): Promise<void> {
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

/** Write pre-serialized text next to `file` with fsync, then rename into place and sync the parent. */
export async function atomicWrite(file: string, text: string): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
        const handle = await fs.promises.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(text);
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

/** Like atomicWrite, but loses to an existing file: links instead of renaming. Returns whether it won. */
export async function exclusiveWrite(file: string, text: string): Promise<boolean> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
        const handle = await fs.promises.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(text);
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

/** Read a JSON artifact, rejecting symlinks, non-files, and oversized content. */
export async function readBoundedJson<T = unknown>(file: string, maximum: number): Promise<T> {
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum)
        throw new Error(`Unsafe or oversized workflow artifact: ${file}`);
    try {
        return JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch {
        throw new Error(`Corrupt workflow artifact: ${file}`);
    }
}

interface DirectoryLockOwner {
    token: string;
    pid: number;
    host: string;
    startedAt?: number;
}

export interface DirectoryLockOptions {
    /** Steal window measured against the lock's mtime (and the owner's startedAt when recorded). */
    staleMs: number;
    /**
     * Blocking policy retries with jitter until the deadline, then throws.
     * Bounded policy makes at most `attempts` acquisition attempts, then returns undefined —
     * including immediately when the lock is held by an owner it may not steal.
     */
    wait: { deadlineMs: number } | { attempts: number };
    /**
     * "stale-and-abandoned" never steals from a live local process or an unverifiable remote host.
     * "stale-or-dead-owner" also presumes a lock held past the stale window is hung, and steals a
     * dead local owner's lock before the window elapses.
     */
    steal: "stale-and-abandoned" | "stale-or-dead-owner";
    /** Also measure staleness from the owner's recorded startedAt, not just the lock's mtime. */
    useOwnerStartedAt?: boolean;
    /** fsync the lock's parent directory after ownership transitions (durable-claim locks). */
    syncParent?: boolean;
    /** Human-readable lock name for error messages, e.g. "workflow approval lock". */
    label: string;
}

async function readLockOwner(lockDirectory: string, label: string): Promise<DirectoryLockOwner | undefined> {
    const file = path.join(lockDirectory, "owner.json");
    const stat = await fs.promises.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) throw new Error(`Unsafe ${label} owner: ${file}`);
    try {
        const owner = JSON.parse(await fs.promises.readFile(file, "utf8"));
        return typeof owner?.token === "string" &&
            Number.isInteger(owner.pid) &&
            owner.pid > 0 &&
            typeof owner.host === "string"
            ? owner
            : undefined;
    } catch {
        return undefined;
    }
}

async function restoreMovedLock(moved: string, lock: string): Promise<void> {
    try {
        await fs.promises.rename(moved, lock);
    } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
    }
}

export async function acquireDirectoryLock(
    lock: string,
    options: DirectoryLockOptions & { wait: { deadlineMs: number } },
): Promise<() => Promise<void>>;
export async function acquireDirectoryLock(
    lock: string,
    options: DirectoryLockOptions,
): Promise<(() => Promise<void>) | undefined>;
export async function acquireDirectoryLock(
    lock: string,
    options: DirectoryLockOptions,
): Promise<(() => Promise<void>) | undefined> {
    const bounded = "attempts" in options.wait ? options.wait : undefined;
    const deadline = "deadlineMs" in options.wait ? Date.now() + options.wait.deadlineMs : undefined;
    let attempt = 0;
    /** Consume retry budget; false means give up (bounded mode only). */
    const retry = async (): Promise<boolean> => {
        if (bounded) return ++attempt < bounded.attempts;
        if (Date.now() >= (deadline ?? 0)) throw new Error(`Timed out waiting for ${options.label}: ${lock}`);
        await sleep(10 + Math.floor(Math.random() * 20));
        return true;
    };
    const maySteal = (stat: fs.Stats, owner: DirectoryLockOwner | undefined): boolean => {
        const deadLocalOwner = owner !== undefined && owner.host === os.hostname() && !isProcessAlive(owner.pid);
        const startedAt =
            options.useOwnerStartedAt && owner?.startedAt !== undefined && Number.isFinite(owner.startedAt)
                ? Math.max(stat.mtimeMs, owner.startedAt)
                : stat.mtimeMs;
        const stale = Date.now() - startedAt > options.staleMs;
        return options.steal === "stale-or-dead-owner" ? stale || deadLocalOwner : stale && (!owner || deadLocalOwner);
    };
    for (;;) {
        const token = crypto.randomUUID(),
            candidate = `${lock}.candidate-${token}`;
        try {
            await fs.promises.mkdir(candidate, { mode: 0o700 });
            try {
                const owner = await fs.promises.open(path.join(candidate, "owner.json"), "wx", 0o600);
                try {
                    await owner.writeFile(
                        JSON.stringify({ token, pid: process.pid, host: os.hostname(), startedAt: Date.now() }),
                    );
                    await owner.sync();
                } finally {
                    await owner.close();
                }
                await fs.promises.rename(candidate, lock);
            } finally {
                await fs.promises.rm(candidate, { recursive: true, force: true });
            }
            if (options.syncParent) await syncDirectory(path.dirname(lock));
            let released = false;
            return async () => {
                if (released) return;
                released = true;
                const current = await readLockOwner(lock, options.label);
                if (current?.token !== token) return;
                const moved = `${lock}.release-${token}`;
                try {
                    await fs.promises.rename(lock, moved);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                    throw error;
                }
                const movedOwner = await readLockOwner(moved, options.label);
                if (movedOwner?.token !== token) {
                    await restoreMovedLock(moved, lock);
                    return;
                }
                await fs.promises.rm(moved, { recursive: true });
                if (options.syncParent) await syncDirectory(path.dirname(lock));
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (!["EEXIST", "ENOTEMPTY", ...(bounded ? ["ENOENT"] : [])].includes(code)) throw error;
            const stat = await fs.promises.lstat(lock).catch((statError: NodeJS.ErrnoException) => {
                if (statError.code === "ENOENT") return undefined;
                throw statError;
            });
            if (!stat) {
                if (!(await retry())) return undefined;
                continue;
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe ${options.label}: ${lock}`);
            const owner = await readLockOwner(lock, options.label);
            if (!maySteal(stat, owner)) {
                if (bounded) return undefined;
                await retry();
                continue;
            }
            const stale = `${lock}.stale-${crypto.randomUUID()}`;
            try {
                await fs.promises.rename(lock, stale);
            } catch (renameError) {
                if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
                    if (!(await retry())) return undefined;
                    continue;
                }
                throw renameError;
            }
            // Re-verify after the rename: a fresh lock could have replaced the stale one in between.
            const movedStat = await fs.promises.lstat(stale),
                movedOwner = await readLockOwner(stale, options.label);
            if (!maySteal(movedStat, movedOwner)) await restoreMovedLock(stale, lock);
            else {
                await fs.promises.rm(stale, { recursive: true });
                if (options.syncParent) await syncDirectory(path.dirname(lock));
            }
            if (!(await retry())) return undefined;
        }
    }
}

function contained(boundary: string, target: string) {
    const relative = path.relative(boundary, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Finds a trusted existing directory above target without trusting a symlink at the target's parent. */
export async function inferDirectoryBoundary(target: string): Promise<string> {
    let candidate = path.dirname(path.resolve(target));
    for (;;) {
        const stat = await fs.promises.lstat(candidate).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) return candidate;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw new Error(`No safe directory boundary for ${target}.`);
        candidate = parent;
    }
}

/** Walks and optionally creates target one component at a time beneath a canonical trusted boundary. */
export async function safeDirectory(target: string, trustedBoundary: string, create: boolean): Promise<string> {
    const boundaryPath = path.resolve(trustedBoundary),
        targetPath = path.resolve(target),
        relative = path.relative(boundaryPath, targetPath);
    if (!contained(boundaryPath, targetPath)) throw new Error("Directory escapes its trusted boundary.");
    const boundary = await fs.promises.realpath(boundaryPath),
        boundaryStat = await fs.promises.stat(boundary);
    if (!boundaryStat.isDirectory()) throw new Error("Trusted boundary is not a directory.");
    let current = boundary;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let stat = await fs.promises.lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
        });
        if (!stat && create) {
            await fs.promises.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error;
            });
            stat = await fs.promises.lstat(current);
        }
        if (!stat) throw Object.assign(new Error(`Directory does not exist: ${current}`), { code: "ENOENT" });
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory component: ${current}`);
        const canonical = await fs.promises.realpath(current);
        if (!contained(boundary, canonical)) throw new Error("Directory escapes its canonical trusted boundary.");
        current = canonical;
    }
    return current;
}
