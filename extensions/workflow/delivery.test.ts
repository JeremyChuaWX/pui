import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitFor } from "../test-support/wait.js";
import { createWorkflowBackend, type WorkflowBackend } from "./backend.js";
import { WorkflowRunManager } from "./manager.js";
import { parseWorkflowRunV1, type WorkflowRunSummaryV1 } from "./protocol.js";
import { WorkflowRunStorage } from "./run-storage.js";

const increment = (counts: Map<string, number>, prompt: string) => counts.set(prompt, (counts.get(prompt) ?? 0) + 1);

test("explicit stop is terminal and is not resumable after restart", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-stop-"));
    const project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    await Bun.$`git init -q ${project}`;
    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => (started = resolve));
    const backendA = createWorkflowBackend({
        storage,
        cooperativeExecutor: true,
        agentExecutor: ({ signal }) =>
            new Promise((_resolve, reject) => {
                started();
                signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
            }),
    });
    let backendB: ReturnType<typeof createWorkflowBackend> | undefined;
    try {
        const { runId } = await backendA.launch({
            name: "stop",
            script: `return await agent("blocked")`,
            sessionId: "stop-test",
            cwd: project,
        });
        await agentStarted;
        await backendA.control(runId, "stop");
        await waitFor(() => backendA.inspect(runId).run.status === "cancelled");
        await backendA.shutdown();
        const [durable] = await storage.discover(project);
        expect(await fs.promises.readFile(path.join(durable!.directory, "workflow.js"), "utf8")).toBe(
            `return await agent("blocked")`,
        );

        backendB = createWorkflowBackend({ storage, agentExecutor: async () => ({ value: "unexpected" }) });
        const initialized = await backendB.initialize!(project);
        expect(initialized.find((run) => run.id === runId)?.status).toBe("cancelled");
        await backendB.recover!(runId);
        expect(backendB.inspect(runId).run.status).toBe("cancelled");
        const [stored] = await storage.discover(project);
        expect(await fs.promises.stat(path.join(stored!.directory, "summary.json"))).toBeTruthy();
        expect(await fs.promises.stat(path.join(stored!.directory, "result.json"))).toBeTruthy();
    } finally {
        await Promise.allSettled([backendA.shutdown(), backendB?.shutdown() ?? Promise.resolve()]);
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("recovers from a durable completion without executing it twice", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-recovery-"));
    const project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    await Bun.$`git init -q ${project}`;

    const countsA = new Map<string, number>();
    const countsB = new Map<string, number>();
    let releaseHook!: () => void;
    let durable!: () => void;
    const blocked = new Promise<void>((resolve) => (releaseHook = resolve));
    const firstDurable = new Promise<void>((resolve) => (durable = resolve));
    let completion = 0;
    // Blocks the run after its first completion is durable but before the worker sees the reply,
    // simulating a host that dies at exactly that point.
    class FirstCompletionBlockingStorage extends WorkflowRunStorage {
        override async complete(directory: string, operation: string, value: unknown, at?: number): Promise<void> {
            await super.complete(directory, operation, value, at);
            if (++completion === 1) {
                durable();
                await blocked;
            }
        }
    }
    const storage = new FirstCompletionBlockingStorage(path.join(temp, "runs"));
    const backendA = createWorkflowBackend({
        storage,
        agentExecutor: async ({ prompt }) => {
            increment(countsA, prompt);
            return { value: `${prompt}-result` };
        },
    });
    let backendB: ReturnType<typeof createWorkflowBackend> | undefined;

    try {
        const blockingScript = `const first=await agent("first"); const second=await agent("second"); return {first,second}`;
        const { runId } = await backendA.launch({
            name: "recovery",
            script: blockingScript,
            sessionId: "recovery-test",
            cwd: project,
        });
        await Promise.race([
            firstDurable,
            Bun.sleep(5_000).then(() => {
                throw new Error("first completion was not made durable");
            }),
        ]);

        await Promise.race([
            backendA.shutdown(),
            Bun.sleep(5_000).then(() => {
                throw new Error("backend shutdown did not cooperatively stop");
            }),
        ]);
        let [interruptedStored] = await storage.discover(project);
        expect(interruptedStored?.snapshot.status).toBe("paused");
        expect(interruptedStored?.snapshot.warning).toContain("resume after restart");
        expect(interruptedStored?.snapshot.endedAt).toBeUndefined();
        expect(
            await fs.promises.stat(path.join(interruptedStored!.directory, "summary.json")).catch(() => undefined),
        ).toBeUndefined();
        expect(
            await fs.promises.stat(path.join(interruptedStored!.directory, "result.json")).catch(() => undefined),
        ).toBeUndefined();
        releaseHook();
        await fs.promises.rename(
            path.join(interruptedStored!.directory, "workflow.js"),
            path.join(interruptedStored!.directory, "workflow.ts"),
        );
        [interruptedStored] = await storage.discover(project);
        expect(interruptedStored?.corrupt).toBeUndefined();
        expect(interruptedStored?.launch.script).toBe(blockingScript);

        backendB = createWorkflowBackend({
            storage,
            agentExecutor: async ({ prompt }) => {
                increment(countsB, prompt);
                return { value: `${prompt}-result` };
            },
        });
        const interrupted = await backendB.initialize!(project);
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]?.id).toBe(runId);
        expect(interrupted[0]?.status).not.toBe("succeeded");

        await backendB.recover!(runId);
        expect(backendB.inspect(runId).run.warning).toBeUndefined();
        await waitFor(() => backendB!.inspect(runId).run.status === "succeeded");
        await backendB.claimTerminalDelivery!(runId);
        expect(JSON.parse(backendB.inspect(runId).result!)).toEqual({
            first: "first-result",
            second: "second-result",
        });
        expect((countsA.get("first") ?? 0) + (countsB.get("first") ?? 0)).toBe(1);
        expect((countsA.get("second") ?? 0) + (countsB.get("second") ?? 0)).toBe(1);

        const [stored] = await storage.discover(project);
        expect(parseWorkflowRunV1(stored?.snapshot)).toEqual(stored?.snapshot);
        const journal = (await fs.promises.readFile(path.join(stored!.directory, "journal.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.type === "completed");
        expect(journal).toHaveLength(2);
        expect(new Set(journal.map((entry) => entry.operation)).size).toBe(2);
    } finally {
        releaseHook();
        await Promise.allSettled([backendA.shutdown(), backendB?.shutdown() ?? Promise.resolve()]);
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

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

const run = (status: WorkflowRunSummaryV1["status"]): WorkflowRunSummaryV1 => ({
    schema: "pi.workflow",
    version: 1,
    id: "r",
    name: "n",
    sessionId: "s",
    cwd: "/x",
    status,
    phases: [],
    agents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 1, maxTokens: 0, maxCost: 0 },
    recentActivity: [],
    updatedAt: 1,
});
test("manager delivers a repeated terminal snapshot exactly once and shuts backend down", async () => {
    let listener: (run: WorkflowRunSummaryV1) => void = () => {};
    let shutdown = 0,
        unsubscribed = 0;
    const backend: WorkflowBackend = {
        launch: async () => ({ runId: "r" }),
        list: () => [],
        inspect: () => ({ run: run("succeeded"), script: "", result: "ok" }),
        subscribe: (fn) => {
            listener = fn;
            return () => unsubscribed++;
        },
        control: async () => undefined,
        shutdown: async () => {
            shutdown++;
        },
    };
    const delivered: any[] = [];
    const manager = new WorkflowRunManager({ backend, emit: () => {}, deliver: (...args) => delivered.push(args) });
    listener(run("succeeded"));
    listener(run("succeeded"));
    expect(delivered).toHaveLength(1);
    await manager.shutdown();
    await manager.shutdown();
    expect(shutdown).toBe(1);
    expect(unsubscribed).toBe(1);
});

test("does not emit, claim, or deliver live runs excluded by host policy", async () => {
    let listener: (run: WorkflowRunSummaryV1) => void = () => {};
    let emissions = 0;
    let claims = 0;
    let deliveries = 0;
    const backend: WorkflowBackend = {
        initialize: async () => [run("succeeded")],
        launch: async () => ({ runId: "r" }),
        list: () => [],
        inspect: () => ({ run: run("succeeded"), script: "", result: "ok" }),
        subscribe: (fn) => {
            listener = fn;
            return () => {};
        },
        control: async () => undefined,
        claimTerminalDelivery: async () => {
            claims++;
            return true;
        },
        shutdown: async () => {},
    };
    const manager = new WorkflowRunManager({
        backend,
        emit: () => emissions++,
        shouldDeliver: () => false,
        deliver: () => deliveries++,
    });

    listener(run("running"));
    listener(run("succeeded"));
    await manager.initialize("/x");
    expect(emissions).toBe(0);
    expect(claims).toBe(0);
    expect(deliveries).toBe(0);
    await manager.shutdown();
});

test("reserves a run while a terminal delivery claim is pending", async () => {
    let listener: (run: WorkflowRunSummaryV1) => void = () => {};
    let resolveClaim: (claimed: boolean) => void = () => {};
    const claim = new Promise<boolean>((resolve) => {
        resolveClaim = resolve;
    });
    let claims = 0;
    let deliveries = 0;
    let resolveDelivery: () => void = () => {};
    const delivered = new Promise<void>((resolve) => {
        resolveDelivery = resolve;
    });
    const backend: WorkflowBackend = {
        initialize: async () => [run("succeeded")],
        launch: async () => ({ runId: "r" }),
        list: () => [],
        inspect: () => ({ run: run("succeeded"), script: "", result: "ok" }),
        subscribe: (fn) => {
            listener = fn;
            return () => {};
        },
        control: async () => undefined,
        claimTerminalDelivery: async () => {
            claims++;
            return claim;
        },
        shutdown: async () => {},
    };
    const manager = new WorkflowRunManager({
        backend,
        emit: () => {},
        deliver: () => {
            deliveries++;
            resolveDelivery();
        },
    });

    listener(run("succeeded"));
    await manager.initialize("/x");
    expect(claims).toBe(1);
    expect(deliveries).toBe(0);
    resolveClaim(true);
    await delivered;
    expect(deliveries).toBe(1);
    await manager.shutdown();
});

test("retries a released terminal claim through recovery", async () => {
    let listener: (run: WorkflowRunSummaryV1) => void = () => {};
    const recoveries: boolean[] = [];
    let attempts = 0;
    let resolveFailure: () => void = () => {};
    let resolveDelivery: () => void = () => {};
    const failure = new Promise<void>((resolve) => {
            resolveFailure = resolve;
        }),
        delivered = new Promise<void>((resolve) => {
            resolveDelivery = resolve;
        });
    const backend: WorkflowBackend = {
        launch: async () => ({ runId: "r" }),
        list: () => [],
        inspect: () => ({ run: run("succeeded"), script: "", result: "ok" }),
        subscribe: (fn) => {
            listener = fn;
            return () => {};
        },
        control: async () => undefined,
        claimTerminalDelivery: async (_id, options) => {
            recoveries.push(options?.recovery ?? false);
            return true;
        },
        markTerminalDelivered: async () => {},
        releaseTerminalDelivery: async () => {},
        shutdown: async () => {},
    };
    const failures: string[] = [];
    const manager = new WorkflowRunManager({
        backend,
        emit: () => {},
        deliver: async () => {
            attempts++;
            if (attempts === 1) throw new Error("temporary delivery failure");
            resolveDelivery();
        },
        log: (message) => {
            failures.push(message);
            resolveFailure();
        },
    });

    try {
        listener(run("succeeded"));
        await failure;
        listener(run("succeeded"));
        await delivered;
        expect(recoveries).toEqual([false, true]);
        expect(failures).toEqual(["Workflow terminal delivery failed: temporary delivery failure"]);
    } finally {
        await manager.shutdown();
    }
});

test("durably delivers recovered terminal runs across storage instances", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-delivery-"));
    const project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    const root = path.join(temp, "runs");
    const storageA = new WorkflowRunStorage(root);
    const managers: WorkflowRunManager[] = [];
    const backend = (storage = new WorkflowRunStorage(root)) =>
        createWorkflowBackend({ storage, agentExecutor: async () => ({ value: null }) });
    const persist = async (id: string, result: unknown) => {
        const summary = { ...run("succeeded"), id, cwd: project, endedAt: 2 };
        const directory = await storageA.create(
            project,
            id,
            {
                name: summary.name,
                sessionId: summary.sessionId,
                cwd: project,
                script: "return null",
                policy: {},
                roles: [],
                models: [],
                limits: summary.limits,
            },
            { ...summary, status: "running" },
        );
        await storageA.terminal(directory, result, summary);
        return directory;
    };
    const manager = (storage: WorkflowRunStorage, deliver: (run: WorkflowRunSummaryV1, result?: string) => unknown) => {
        const value = new WorkflowRunManager({ backend: backend(storage), emit: () => {}, deliver });
        managers.push(value);
        return value;
    };

    try {
        const result = { answer: 42 };
        const firstDirectory = await persist("persisted", result);
        const deliveries: unknown[] = [];
        await manager(new WorkflowRunStorage(root), (_run, value) => deliveries.push(value)).initialize(project);
        expect(deliveries).toEqual([JSON.stringify(result)]);
        expect(
            JSON.parse(await fs.promises.readFile(path.join(firstDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({
            delivered: true,
        });

        await manager(new WorkflowRunStorage(root), (_run, value) => deliveries.push(value)).initialize(project);
        expect(deliveries).toEqual([JSON.stringify(result)]);

        const claimedDirectory = await persist("abandoned-claim", "ready");
        await fs.promises.writeFile(
            path.join(claimedDirectory, "delivery.json"),
            JSON.stringify({
                version: 1,
                claimed: true,
                claimedAt: Date.now() - 60_000,
                owner: "stopped-host",
            }),
        );
        const stale = new Date(Date.now() - 60_000);
        await fs.promises.utimes(path.join(claimedDirectory, "delivery.json"), stale, stale);
        const claimedDeliveries: unknown[] = [];
        await manager(new WorkflowRunStorage(root), (_run, value) => claimedDeliveries.push(value)).initialize(project);
        expect(claimedDeliveries).toEqual([JSON.stringify("ready")]);
        expect(
            JSON.parse(await fs.promises.readFile(path.join(claimedDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({ delivered: true });

        const corruptDirectory = await persist("corrupt", "unsafe");
        await fs.promises.writeFile(path.join(corruptDirectory, "launch.json"), "{");
        const beforeCorrupt = claimedDeliveries.length;
        const corruptRuns = await manager(new WorkflowRunStorage(root), (_run, value) =>
            claimedDeliveries.push(value),
        ).initialize(project);
        expect(corruptRuns.find(({ id }) => id === "corrupt")?.error).toContain("Stored workflow is corrupt");
        expect(claimedDeliveries).toHaveLength(beforeCorrupt);
        expect(
            await fs.promises.stat(path.join(corruptDirectory, "delivery.json")).catch(() => undefined),
        ).toBeUndefined();

        const retryDirectory = await persist("retry", "eventual");
        const failing = manager(new WorkflowRunStorage(root), async (summary) => {
            if (summary.id === "retry") throw new Error("delivery unavailable");
        });
        await expect(failing.initialize(project)).rejects.toThrow("delivery unavailable");
        expect(
            JSON.parse(await fs.promises.readFile(path.join(retryDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({
            claimed: true,
        });

        const retried: unknown[] = [];
        await manager(new WorkflowRunStorage(root), (summary, value) => {
            if (summary.id === "retry") retried.push(value);
        }).initialize(project);
        expect(retried).toEqual([JSON.stringify("eventual")]);
        expect(
            JSON.parse(await fs.promises.readFile(path.join(retryDirectory, "delivery.json"), "utf8")),
        ).toMatchObject({
            delivered: true,
        });
    } finally {
        await Promise.allSettled(managers.map((value) => value.shutdown()));
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
