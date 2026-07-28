import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkflowApprovalStore {
    has(key: string): Promise<boolean>;
    add(key: string): Promise<void>;
}
export function workflowApprovalKey(project: string, name: string, script: string): string {
    const hash = createHash("sha256").update(Buffer.from(script)).digest("hex");
    return `${project}\0${name}\0${hash}`;
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
    async has(key: string) {
        return (await this.read()).has(key);
    }
    async add(key: string) {
        const keys = await this.read();
        keys.add(key);
        await this.safeParents(true);
        const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(temp, JSON.stringify({ version: 1, keys: [...keys].sort() }), {
                mode: 0o600,
                flag: "wx",
            });
            await fs.promises.rename(temp, this.file);
            await fs.promises.chmod(this.file, 0o600);
        } finally {
            await fs.promises.rm(temp, { force: true });
        }
    }
}
