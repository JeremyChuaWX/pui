import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowBackend } from "./backend.js";
import { WorkflowWorktreeManager } from "./worktree.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((p) => fs.promises.rm(p, { recursive: true, force: true }))));
async function repository() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-worktree-test-"));
    temporary.push(root);
    for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]])
        expect((await Bun.$`git -C ${root} ${args}`.quiet()).exitCode).toBe(0);
    await fs.promises.writeFile(path.join(root, "file"), "initial");
    expect((await Bun.$`git -C ${root} add file`.quiet()).exitCode).toBe(0);
    expect((await Bun.$`git -C ${root} commit -m initial`.quiet()).exitCode).toBe(0);
    return root;
}
async function waitFor(status: () => string, expected: string) {
    const ceiling = Number(process.env.PUI_TEST_WAIT_MS ?? 15_000),
        deadline = Date.now() + ceiling;
    let last = status();
    while (last !== expected && Date.now() < deadline) {
        await Bun.sleep(20);
        last = status();
    }
    if (last !== expected)
        throw new Error(`Timed out after ${ceiling}ms waiting for ${expected}; last status: ${last}`);
}

describe("workflow worktree isolation", () => {
    test("manager resolves nested repositories, creates distinct worktrees, and retains branches", async () => {
        const root = await repository(),
            nested = path.join(root, "nested"),
            base = `${root}-owned`;
        temporary.push(base);
        await fs.promises.mkdir(nested);
        const manager = new WorkflowWorktreeManager(base);
        expect(await manager.repository(nested)).toBe(await fs.promises.realpath(root));
        const a = await manager.create(nested, "run", "one"),
            b = await manager.create(root, "run", "two");
        expect(a.cwd).not.toBe(b.cwd);
        expect((await Bun.$`git -C ${root} worktree list --porcelain`.text()).includes(a.cwd)).toBe(true);
        await expect(
            manager.cleanup(root, {
                ...a,
                ref: "refs/pui/workflows/run/../../heads/main",
            }),
        ).rejects.toThrow("Unsafe ownership ref");
        await manager.cleanup(root, a);
        expect((await Bun.$`git -C ${root} show-ref --verify refs/heads/${a.branch}`.quiet()).exitCode).toBe(0);
        expect((await Bun.$`git -C ${root} for-each-ref refs/pui/workflows`.text()).includes(a.ref)).toBe(false);
        await manager.cleanup(root, b);
    });
    test("rejects mismatched ownership before running git commands", async () => {
        const root = await repository(),
            base = `${root}-owned`,
            commandLog = path.join(root, "git-commands"),
            recorder = path.join(root, "record-git");
        temporary.push(base);
        await fs.promises.writeFile(
            recorder,
            `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 99\n`,
            { mode: 0o755 },
        );
        const owner = new WorkflowWorktreeManager(base),
            owned = await owner.create(root, "run", "operation"),
            guarded = new WorkflowWorktreeManager(base, { git: recorder });
        await expect(guarded.cleanup(root, { ...owned, branch: "pui-workflow/run/other" })).rejects.toThrow(
            "Mismatched worktree ownership",
        );
        expect(await fs.promises.readFile(commandLog, "utf8").catch(() => "")).toBe("");
        await owner.cleanup(root, owned);
    });
    test("rejects a symlink in the direct worktree-base ancestry", async () => {
        const boundary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-worktree-boundary-")),
            outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-worktree-outside-")),
            link = path.join(boundary, "linked");
        temporary.push(boundary, outside);
        await fs.promises.symlink(outside, link, "dir");
        const manager = new WorkflowWorktreeManager(path.join(link, "worktrees"), {
            trustedBoundary: boundary,
        });
        await expect(manager.create(await repository(), "run", "operation")).rejects.toThrow(
            "Unsafe directory component",
        );
    });
    test("backend rejects unsafe parallel writers and isolates workers without model calls", async () => {
        const root = await repository(),
            base = `${root}-owned`,
            cwds: string[] = [];
        temporary.push(base);
        let sharedExecutions = 0,
            activeRootExecutions = 0,
            maxActiveRootExecutions = 0;
        const rejected = createWorkflowBackend({
            agentExecutor: async ({ cwd }) => {
                sharedExecutions++;
                expect(cwd).toBe(await fs.promises.realpath(root));
                activeRootExecutions++;
                maxActiveRootExecutions = Math.max(maxActiveRootExecutions, activeRootExecutions);
                try {
                    await Bun.sleep(50);
                    return { value: null };
                } finally {
                    activeRootExecutions--;
                }
            },
        });
        try {
            const sequential = await rejected.launch({
                name: "sequential",
                script: `await agent("x")`,
                sessionId: "s",
                cwd: root,
            });
            await waitFor(() => rejected.inspect(sequential.runId).run.status, "succeeded");
            const bad = await rejected.launch({
                name: "bad",
                script: `await parallel([agent("x"),agent("y")])`,
                sessionId: "s",
                cwd: root,
            });
            await waitFor(() => rejected.inspect(bad.runId).run.status, "failed");
            expect(sharedExecutions).toBeGreaterThanOrEqual(2);
            expect(maxActiveRootExecutions).toBe(1);
        } finally {
            await rejected.shutdown();
        }
        const backend = createWorkflowBackend({
            worktreeManager: new WorkflowWorktreeManager(base),
            agentExecutor: async ({ cwd }) => {
                cwds.push(cwd);
                await Bun.sleep(30);
                return { value: cwd };
            },
        });
        try {
            const run = await backend.launch({
                name: "isolated",
                script: `return await parallel([agent("a",{role:"worker",isolation:"worktree"}),agent("b",{role:"worker",isolation:"worktree"})])`,
                sessionId: "s",
                cwd: root,
            });
            await waitFor(() => backend.inspect(run.runId).run.status, "succeeded");
            expect(new Set(cwds).size).toBe(2);
            expect(cwds.every((cwd) => cwd !== root)).toBe(true);
            expect(backend.inspect(run.runId).run.agents.every((agent) => agent.worktree?.branch)).toBe(true);
        } finally {
            await backend.shutdown();
        }
    });
});
