import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkflowApprovalStore {
    has(key: string): Promise<boolean>;
    add(key: string): Promise<void>;
}
const approvalWrites = new Map<string, Promise<void>>();
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
interface ApprovalLockOwner {
    token: string;
    pid: number;
    host: string;
}
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
export function workflowApprovalKey(project: string, sourceIdentity: string, script: string): string {
    const hash = createHash("sha256").update(Buffer.from(script)).digest("hex");
    return `${project}\0${sourceIdentity}\0${hash}`;
}
export class FileWorkflowApprovalStore implements WorkflowApprovalStore {
    constructor(
        private readonly file = path.join(os.homedir(), ".pi", "agent", "workflow-approvals.json"),
        private readonly boundary = os.homedir(),
    ) {}
    private async safeParents(create = false): Promise<void> {
        const relative = path.relative(path.resolve(this.boundary), path.resolve(path.dirname(this.file)));
        const boundary = await fs.promises.realpath(this.boundary);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("Approval store escapes its boundary.");
        let current = boundary;
        for (const part of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                const stat = await fs.promises.lstat(current);
                if (stat.isSymbolicLink() || !stat.isDirectory())
                    throw new Error(`Unsafe approval directory: ${current}`);
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
                await fs.promises.mkdir(current, { mode: 0o700 });
            }
        }
    }
    private async read(): Promise<Set<string>> {
        try {
            await this.safeParents();
            const stat = await fs.promises.lstat(this.file);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024)
                throw new Error(`Unsafe workflow approval store: ${this.file}`);
            const value = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
            if (
                value?.version !== 1 ||
                !Array.isArray(value.keys) ||
                value.keys.length > 10_000 ||
                !value.keys.every((x: unknown) => typeof x === "string" && x.length <= 8_000)
            )
                throw new Error(`Corrupt workflow approval store: ${this.file}`);
            return new Set(value.keys);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
            throw error;
        }
    }
    private async readLockOwner(directory: string): Promise<ApprovalLockOwner | undefined> {
        const file = path.join(directory, "owner.json");
        const stat = await fs.promises.lstat(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        if (!stat) return undefined;
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096)
            throw new Error(`Unsafe workflow approval lock owner: ${file}`);
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
    private async restoreMovedLock(moved: string, lock: string): Promise<void> {
        try {
            await fs.promises.rename(moved, lock);
        } catch (error) {
            if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw error;
        }
    }
    private async acquireLock(): Promise<() => Promise<void>> {
        await this.safeParents(true);
        const lock = `${this.file}.lock`;
        const deadline = Date.now() + LOCK_WAIT_MS;
        const retry = async () => {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for workflow approval lock: ${lock}`);
            await sleep(10 + Math.floor(Math.random() * 20));
        };
        for (;;) {
            const token = crypto.randomUUID(),
                candidate = `${lock}.candidate-${token}`;
            try {
                await fs.promises.mkdir(candidate, { mode: 0o700 });
                try {
                    const owner = await fs.promises.open(path.join(candidate, "owner.json"), "wx", 0o600);
                    try {
                        await owner.writeFile(JSON.stringify({ token, pid: process.pid, host: os.hostname() }));
                        await owner.sync();
                    } finally {
                        await owner.close();
                    }
                    await fs.promises.rename(candidate, lock);
                } finally {
                    await fs.promises.rm(candidate, { recursive: true, force: true });
                }
                return async () => {
                    const current = await this.readLockOwner(lock);
                    if (current?.token !== token) return;
                    const released = `${lock}.release-${token}`;
                    try {
                        await fs.promises.rename(lock, released);
                    } catch (error: unknown) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                        throw error;
                    }
                    const moved = await this.readLockOwner(released);
                    if (moved?.token !== token) {
                        await this.restoreMovedLock(released, lock);
                        return;
                    }
                    await fs.promises.rm(released, { recursive: true });
                };
            } catch (error: unknown) {
                if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
                const stat = await fs.promises.lstat(lock).catch((statError: NodeJS.ErrnoException) => {
                    if (statError.code === "ENOENT") return undefined;
                    throw statError;
                });
                if (!stat) {
                    await retry();
                    continue;
                }
                if (stat.isSymbolicLink() || !stat.isDirectory())
                    throw new Error(`Unsafe workflow approval lock: ${lock}`);
                const owner = await this.readLockOwner(lock),
                    abandoned = !owner || (owner.host === os.hostname() && !isProcessAlive(owner.pid));
                // Never steal a lock owned by a live local process or an unverifiable remote host.
                if (Date.now() - stat.mtimeMs > LOCK_STALE_MS && abandoned) {
                    const stale = `${lock}.stale-${crypto.randomUUID()}`;
                    try {
                        await fs.promises.rename(lock, stale);
                    } catch (renameError: unknown) {
                        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
                            await retry();
                            continue;
                        }
                        throw renameError;
                    }
                    const movedStat = await fs.promises.lstat(stale),
                        movedOwner = await this.readLockOwner(stale),
                        movedAbandoned =
                            !movedOwner || (movedOwner.host === os.hostname() && !isProcessAlive(movedOwner.pid));
                    if (Date.now() - movedStat.mtimeMs <= LOCK_STALE_MS || !movedAbandoned)
                        await this.restoreMovedLock(stale, lock);
                    else await fs.promises.rm(stale, { recursive: true });
                    await retry();
                    continue;
                }
                await retry();
            }
        }
    }
    private async syncDirectory(): Promise<void> {
        let directory: fs.promises.FileHandle | undefined;
        try {
            directory = await fs.promises.open(path.dirname(this.file), "r");
            await directory.sync();
        } catch (error) {
            if (
                process.platform !== "win32" ||
                !["EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
                throw error;
        } finally {
            await directory?.close();
        }
    }
    async has(key: string) {
        return (await this.read()).has(key);
    }
    async add(key: string) {
        const identity = path.resolve(this.file),
            previous = approvalWrites.get(identity) ?? Promise.resolve(),
            write = previous.then(async () => {
                const release = await this.acquireLock();
                try {
                    const keys = await this.read();
                    if (keys.has(key)) return;
                    if (key.length > 8_000) throw new Error("Workflow approval key exceeds 8,000 characters.");
                    if (keys.size >= 10_000) throw new Error("Workflow approval store is limited to 10,000 keys.");
                    keys.add(key);
                    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
                    try {
                        const handle = await fs.promises.open(temp, "wx", 0o600);
                        try {
                            await handle.writeFile(JSON.stringify({ version: 1, keys: [...keys].sort() }));
                            await handle.sync();
                        } finally {
                            await handle.close();
                        }
                        await fs.promises.rename(temp, this.file);
                        await this.syncDirectory();
                    } finally {
                        await fs.promises.rm(temp, { force: true });
                    }
                } finally {
                    await release();
                }
            });
        const settled = write.catch(() => {});
        approvalWrites.set(identity, settled);
        try {
            await write;
        } finally {
            if (approvalWrites.get(identity) === settled) approvalWrites.delete(identity);
        }
    }
}
