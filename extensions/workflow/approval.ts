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
    constructor(private readonly file = path.join(os.homedir(), ".pi", "agent", "workflow-approvals.json")) {}
    private async read(): Promise<Set<string>> {
        try {
            const stat = await fs.promises.lstat(this.file);
            if (stat.isSymbolicLink() || !stat.isFile())
                throw new Error(`Unsafe workflow approval store: ${this.file}`);
            const value = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
            return new Set(Array.isArray(value?.keys) ? value.keys.filter((x: unknown) => typeof x === "string") : []);
        } catch (error: any) {
            if (error?.code === "ENOENT") return new Set();
            throw error;
        }
    }
    async has(key: string) {
        return (await this.read()).has(key);
    }
    async add(key: string) {
        const keys = await this.read();
        keys.add(key);
        const directory = path.dirname(this.file);
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
        await fs.promises.writeFile(temp, JSON.stringify({ version: 1, keys: [...keys].sort() }), {
            mode: 0o600,
            flag: "wx",
        });
        await fs.promises.rename(temp, this.file);
    }
}
