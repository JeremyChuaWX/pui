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
    await Bun.$`git -C ${root} add file`.quiet();
    await Bun.$`git -C ${root} commit -m initial`.quiet();
    return root;
}
async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(10);
    expect(predicate()).toBe(true);
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
        await manager.cleanup(root, a);
        expect((await Bun.$`git -C ${root} show-ref --verify refs/heads/${a.branch}`.quiet()).exitCode).toBe(0);
        expect((await Bun.$`git -C ${root} for-each-ref refs/pui/workflows`.text()).includes(a.ref)).toBe(false);
        await manager.cleanup(root, b);
    });
    test("backend rejects unsafe parallel writers and isolates workers without model calls", async () => {
        const root = await repository(),
            base = `${root}-owned`,
            cwds: string[] = [];
        temporary.push(base);
        const rejected = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
        const bad = await rejected.launch({ name: "bad", script: `await agent("x")`, sessionId: "s", cwd: root });
        await waitFor(() => rejected.inspect(bad.runId).run.status === "failed");
        await rejected.shutdown();
        const backend = createWorkflowBackend({
            worktreeManager: new WorkflowWorktreeManager(base),
            agentExecutor: async ({ cwd }) => {
                cwds.push(cwd);
                await Bun.sleep(30);
                return { value: cwd };
            },
        });
        const run = await backend.launch({
            name: "isolated",
            script: `return await parallel([agent("a",{role:"worker",isolation:"worktree"}),agent("b",{role:"worker",isolation:"worktree"})])`,
            sessionId: "s",
            cwd: root,
        });
        await waitFor(() => backend.inspect(run.runId).run.status === "succeeded");
        expect(new Set(cwds).size).toBe(2);
        expect(cwds.every((cwd) => cwd !== root)).toBe(true);
        expect(backend.inspect(run.runId).run.agents.every((agent) => agent.worktree?.branch)).toBe(true);
        await backend.shutdown();
    });
});
