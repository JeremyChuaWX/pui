import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "",
            err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err = `${err}${c}`.slice(-4000)));
        child.once("error", reject);
        child.once("close", (code) =>
            code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} failed: ${err.trim()}`)),
        );
    });
}
export interface OwnedWorktree {
    cwd: string;
    branch: string;
    ref: string;
}
/** Creates bounded per-operation worktrees. Ownership refs make cleanup auditable after crashes. */
export class WorkflowWorktreeManager {
    constructor(private readonly base: string) {}
    async create(repository: string, runId: string, operation: string): Promise<OwnedWorktree> {
        if (!SAFE.test(runId) || !SAFE.test(operation)) throw new Error("Unsafe worktree identity.");
        const root = await fs.promises.realpath(repository),
            gitRoot = await git(root, ["rev-parse", "--show-toplevel"]);
        if ((await fs.promises.realpath(gitRoot)) !== root)
            throw new Error("Workflow cwd must be the canonical repository root for worktree isolation.");
        await fs.promises.mkdir(this.base, { recursive: true, mode: 0o700 });
        const canonicalBase = await fs.promises.realpath(this.base),
            cwd = path.join(canonicalBase, `${runId}-${operation}`),
            branch = `pui-workflow/${runId}/${operation}`,
            ref = `refs/pui/workflows/${runId}/${operation}`;
        if (path.relative(canonicalBase, cwd).startsWith("..")) throw new Error("Worktree path escapes its boundary.");
        await git(root, ["update-ref", ref, "HEAD"]);
        try {
            await git(root, ["worktree", "add", "-b", branch, "--", cwd, ref]);
        } catch (e) {
            await git(root, ["update-ref", "-d", ref]).catch(() => {});
            throw e;
        }
        const canonical = await fs.promises.realpath(cwd);
        if (path.relative(canonicalBase, canonical).startsWith(".."))
            throw new Error("Canonical worktree escapes its boundary.");
        return { cwd: canonical, branch, ref };
    }
    async cleanup(repository: string, owned: OwnedWorktree): Promise<void> {
        const root = await fs.promises.realpath(repository),
            canonicalBase = await fs.promises.realpath(this.base),
            canonical = await fs.promises.realpath(owned.cwd).catch(() => owned.cwd);
        if (path.relative(canonicalBase, canonical).startsWith(".."))
            throw new Error("Refusing unsafe worktree cleanup.");
        await git(root, ["worktree", "remove", "--force", "--", canonical]);
        await git(root, ["update-ref", "-d", owned.ref]);
        // Branches are deliberately retained: no merge or history deletion is automatic.
    }
}
