import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireDirectoryLock, atomicWrite } from "./durable-fs.js";

export interface WorkflowApprovalStore {
    has(key: string): Promise<boolean>;
    add(key: string): Promise<void>;
}
// Change this namespace whenever approved source gains a new host capability.
const APPROVAL_CAPABILITY_VERSION = "pui-workflow-shell-v1";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
export function workflowApprovalKey(project: string, sourceIdentity: string, script: string): string {
    const hash = createHash("sha256")
        .update(APPROVAL_CAPABILITY_VERSION)
        .update("\0")
        .update(Buffer.from(script))
        .digest("hex");
    return `${project}\0${sourceIdentity}\0${hash}`;
}
export class FileWorkflowApprovalStore implements WorkflowApprovalStore {
    private readonly writes = new Map<string, Promise<void>>();
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
    private async acquireLock(): Promise<() => Promise<void>> {
        await this.safeParents(true);
        return acquireDirectoryLock(`${this.file}.lock`, {
            staleMs: LOCK_STALE_MS,
            wait: { deadlineMs: LOCK_WAIT_MS },
            steal: "stale-and-abandoned",
            label: "workflow approval lock",
        });
    }
    async has(key: string) {
        return (await this.read()).has(key);
    }
    async add(key: string) {
        const identity = path.resolve(this.file),
            previous = this.writes.get(identity) ?? Promise.resolve(),
            write = previous.then(async () => {
                const release = await this.acquireLock();
                try {
                    const keys = await this.read();
                    if (keys.has(key)) return;
                    if (key.length > 8_000) throw new Error("Workflow approval key exceeds 8,000 characters.");
                    if (keys.size >= 10_000) throw new Error("Workflow approval store is limited to 10,000 keys.");
                    keys.add(key);
                    await atomicWrite(this.file, JSON.stringify({ version: 1, keys: [...keys].sort() }));
                } finally {
                    await release();
                }
            });
        const settled = write.catch(() => {});
        this.writes.set(identity, settled);
        try {
            await write;
        } finally {
            if (this.writes.get(identity) === settled) this.writes.delete(identity);
        }
    }
}
