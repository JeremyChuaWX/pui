import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedProcessError, runBoundedProcess } from "../shared/bounded-process.js";
import { inferDirectoryBoundary, safeDirectory } from "./safe-directory.js";

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const OWNED_REF = /^refs\/pui\/workflows\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/;
const OUTPUT_LIMIT = 16 * 1024;
export interface WorktreeManagerOptions {
    git?: string;
    timeoutMs?: number;
    trustedBoundary?: string;
}
export interface OwnedWorktree {
    cwd: string;
    branch: string;
    ref: string;
}

/** Creates bounded per-operation worktrees. Ownership refs make cleanup auditable after crashes. */
export class WorkflowWorktreeManager {
    private readonly gitExecutable: string;
    private readonly timeoutMs: number;
    private readonly trustedBoundary?: string;
    constructor(
        private readonly base: string,
        options: WorktreeManagerOptions = {},
    ) {
        this.gitExecutable = options.git ?? "git";
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.trustedBoundary = options.trustedBoundary;
    }
    private async command(cwd: string, args: string[]): Promise<string> {
        const env = { ...process.env };
        delete env.GIT_DIR;
        delete env.GIT_WORK_TREE;
        delete env.GIT_INDEX_FILE;
        let result: Awaited<ReturnType<typeof runBoundedProcess>>;
        try {
            result = await runBoundedProcess({
                command: this.gitExecutable,
                args,
                cwd,
                env,
                timeoutMs: args[0] === "worktree" && args[1] === "add" ? this.timeoutMs * 6 : this.timeoutMs,
                output: { maxBytes: OUTPUT_LIMIT, overflow: "keep-tail" },
            });
        } catch (error) {
            if (error instanceof BoundedProcessError && error.reason === "timeout")
                throw new Error(`git ${args[0]} timed out`);
            throw error;
        }
        if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
        return result.stdout.trim();
    }
    async repository(cwd: string): Promise<string> {
        const canonical = await fs.promises.realpath(cwd),
            top = await this.command(canonical, ["rev-parse", "--show-toplevel"]);
        return fs.promises.realpath(top);
    }
    private async canonicalBase() {
        const boundary = this.trustedBoundary ?? (await inferDirectoryBoundary(this.base));
        return safeDirectory(this.base, boundary, true);
    }
    async create(repository: string, runId: string, operation: string): Promise<OwnedWorktree> {
        if (!SAFE.test(runId) || !SAFE.test(operation)) throw new Error("Unsafe worktree identity.");
        const root = await this.repository(repository),
            base = await this.canonicalBase(),
            cwd = path.join(base, `${runId}-${operation}`),
            branch = `pui-workflow/${runId}/${operation}`,
            ref = `refs/pui/workflows/${runId}/${operation}`,
            relative = path.relative(base, cwd);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("Worktree path escapes its boundary.");
        await fs.promises.lstat(cwd).then(
            () => Promise.reject(new Error("Worktree path already exists.")),
            () => undefined,
        );
        // Both names are ownership boundaries. Never reuse an existing ref or branch.
        if (
            await this.command(root, ["show-ref", "--verify", "--quiet", ref]).then(
                () => true,
                () => false,
            )
        )
            throw new Error("Worktree ownership ref already exists.");
        if (
            await this.command(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
                () => true,
                () => false,
            )
        )
            throw new Error("Worktree branch already exists.");
        await this.command(root, ["update-ref", ref, "HEAD", ""]);
        try {
            await this.command(root, ["worktree", "add", "-b", branch, "--", cwd, ref]);
            const canonical = await fs.promises.realpath(cwd),
                rel = path.relative(base, canonical);
            if (rel.startsWith("..") || path.isAbsolute(rel))
                throw new Error("Canonical worktree escapes its boundary.");
            return { cwd: canonical, branch, ref };
        } catch (error) {
            await this.command(root, ["worktree", "remove", "--force", "--", cwd]).catch(() => {});
            await this.command(root, ["update-ref", "-d", ref]).catch(() => {});
            throw error;
        }
    }
    async cleanup(repository: string, owned: OwnedWorktree): Promise<void> {
        const identity = OWNED_REF.exec(owned.ref);
        if (!identity) throw new Error("Unsafe ownership ref.");
        const [, runId, operation] = identity;
        if (
            owned.branch !== `pui-workflow/${runId}/${operation}` ||
            path.basename(path.resolve(owned.cwd)) !== `${runId}-${operation}`
        )
            throw new Error("Mismatched worktree ownership.");
        const root = await this.repository(repository),
            base = await this.canonicalBase(),
            resolved = path.resolve(owned.cwd),
            rel = path.relative(base, resolved);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Refusing unsafe worktree cleanup.");
        const stat = await fs.promises.lstat(resolved).catch(() => undefined);
        if (stat) await safeDirectory(resolved, base, false);
        if (stat?.isSymbolicLink()) throw new Error("Refusing symlink worktree cleanup.");
        await this.command(root, ["worktree", "remove", "--force", "--", resolved]).catch((e) => {
            if (stat) throw e;
        });
        await this.command(root, ["update-ref", "-d", owned.ref]);
        // Branches are deliberately retained: no merge or history deletion is automatic.
    }
}
