import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitFor } from "../test-support/wait.js";
import { createWorkflowBackend } from "./backend.js";
import { WorkflowRunStorage } from "./run-storage.js";

class BarrierStorage extends WorkflowRunStorage {
    entered?: Promise<void>;
    claims = 0;
    private enter?: () => void;
    private release?: () => void;

    armTerminalBarrier() {
        this.entered = new Promise<void>((resolve) => (this.enter = resolve));
    }

    override async terminal(...args: Parameters<WorkflowRunStorage["terminal"]>) {
        if (this.enter) {
            this.enter();
            this.enter = undefined;
            await new Promise<void>((resolve) => (this.release = resolve));
        }
        await super.terminal(...args);
    }

    override async claimDelivery(...args: Parameters<WorkflowRunStorage["claimDelivery"]>) {
        this.claims++;
        return super.claimDelivery(...args);
    }

    unblock() {
        this.release?.();
        this.release = undefined;
    }
}

test("discovery sees the last nonterminal snapshot while terminal artifacts are in flight", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-terminal-race-"));
    const cwd = path.join(temp, "project");
    await fs.promises.mkdir(cwd);
    const storage = new BarrierStorage(path.join(temp, "runs"));
    let backend: ReturnType<typeof createWorkflowBackend>,
        claimStarted = false,
        claimResolved = false,
        claimed = false;
    backend = createWorkflowBackend({
        storage,
        agentExecutor: async () => ({ value: "done" }),
        eventSink: (run) => {
            if (run.status === "succeeded") {
                claimStarted = true;
                void backend.claimTerminalDelivery!(run.id).then((value) => {
                    claimed = value;
                    claimResolved = true;
                });
            }
        },
    });
    storage.armTerminalBarrier();
    try {
        const { runId } = await backend.launch({
            name: "terminal-race",
            script: `return "done"`,
            sessionId: "terminal-race-test",
            cwd,
        });
        await storage.entered;
        expect(backend.inspect(runId).run.status).toBe("succeeded");
        expect(claimStarted).toBe(true);
        expect(claimResolved).toBe(false);
        expect(storage.claims).toBe(0);

        const stored = (await storage.discover(cwd)).find(({ id }) => id === runId);
        expect(stored?.corrupt).toBeUndefined();
        expect(stored?.snapshot.status).not.toBe("succeeded");

        storage.unblock();
        await waitFor(() => claimResolved);
        expect(storage.claims).toBe(1);
        expect(claimed).toBe(true);
        const durable = (await storage.discover(cwd)).find(({ id }) => id === runId);
        expect(durable?.snapshot.status).toBe("succeeded");
        expect(durable?.result).toBe('"done"');
    } finally {
        storage.unblock();
        await backend.shutdown();
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("retry and agent restart create linked runs with durable replay", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-controls-"));
    const cwd = path.join(temp, "project");
    await fs.promises.mkdir(cwd);
    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    let executions = 0;
    const backend = createWorkflowBackend({
        storage,
        agentExecutor: async ({ prompt }) => {
            executions++;
            if (prompt === "block") return await new Promise(() => {});
            return { value: `${prompt}-result` };
        },
    });
    const script = `export default async function workflow(context, args) {
    const results = await context.parallel([
        context.agent("one", { role: "explore" }),
        context.agent("two", { role: "explore" }),
    ]);
    return { args, results };
}`;
    const args = { nested: [1, "exact"], enabled: true };
    const limits = { maxConcurrency: 4, maxAgents: 1_000, timeoutMs: 12_345, maxTokens: 0, maxCost: 0 } as const;

    try {
        const old = await backend.launch({
            name: "linked",
            script,
            entrypoint: "function",
            args,
            limits,
            sessionId: "session",
            cwd,
        });
        await waitFor(() => backend.inspect(old.runId).run.status === "succeeded");
        expect(executions).toBe(2);
        const oldRun = backend.inspect(old.runId).run;
        expect(oldRun.agents).toHaveLength(2);

        const retried = await backend.control(old.runId, { action: "retry" });
        expect(retried?.runId).toBeString();
        expect(retried?.runId).not.toBe(old.runId);
        await waitFor(() => backend.inspect(retried!.runId!).run.status === "succeeded");
        expect(executions).toBe(2);

        const retryStored = (await storage.discover(cwd)).find(({ id }) => id === retried!.runId);
        expect(retryStored?.launch).toMatchObject({
            args,
            limits,
            script,
            entrypoint: "function",
            parentRunId: old.runId,
        });
        expect(retryStored?.launch.args).toEqual(args);
        expect(retryStored?.launch.script).toBe(script);

        const selected = oldRun.agents[0]!.id;
        const sibling = oldRun.agents[1]!.id;
        const restarted = await backend.control(old.runId, { action: "restart-agent", agentId: selected });
        expect(restarted?.runId).toBeString();
        expect(restarted?.runId).not.toBe(old.runId);
        await waitFor(() => backend.inspect(restarted!.runId!).run.status === "succeeded");
        expect(executions).toBe(3);
        const restartStored = (await storage.discover(cwd)).find(({ id }) => id === restarted!.runId);
        expect(restartStored?.launch.parentRunId).toBe(old.runId);
        expect(restartStored?.completions.has(selected)).toBe(true);
        expect(restartStored?.completions.has(sibling)).toBe(true);

        await expect(backend.control(old.runId, { action: "restart-agent", agentId: "not-an-agent" })).rejects.toThrow(
            "Invalid completed agent identity",
        );

        const running = await backend.launch({
            name: "running",
            script: `await agent("block",{role:"explore"})`,
            sessionId: "session",
            cwd,
        });
        await waitFor(() => backend.inspect(running.runId).run.status === "running");
        await expect(backend.control(running.runId, { action: "retry" })).rejects.toThrow("terminal");
        await expect(backend.control(running.runId, { action: "restart-agent", agentId: selected })).rejects.toThrow(
            "terminal",
        );
        await backend.control(running.runId, "stop");
    } finally {
        await backend.shutdown();
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
