import { describe, expect, test } from "bun:test";
import { Manager } from "#modules/subagents/manager.js";
import type { JobConfig, JobResult, Runner, RunResult } from "#modules/subagents/protocol.js";
import { createFakeClock, settleEventLoop } from "#test-support/fake-clock.js";

const config = (overrides: Partial<JobConfig> = {}): JobConfig => ({
    profile: "explorer",
    task: "look around",
    cwd: "/tmp",
    tools: ["read"],
    model: "openrouter/z-ai/glm-5.3-flash",
    thinkingLevel: "low",
    systemPrompt: "be brief",
    promptMode: "replace",
    inactivityMs: 10_000,
    hardMs: 60_000,
    ...overrides,
});

const ok = (text = "done"): RunResult => ({
    text,
    partial: false,
    usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
});

function fakeRunner() {
    const started: Array<{
        config: JobConfig;
        signal: AbortSignal;
        onActivity: () => void;
        resolve: (result: RunResult) => void;
        reject: (error: unknown) => void;
    }> = [];
    const run: Runner = (jobConfig, signal, onActivity) =>
        new Promise<RunResult>((resolve, reject) => {
            started.push({ config: jobConfig, signal, onActivity, resolve, reject });
        });
    return { run, started };
}

function setup(overrides: Partial<ConstructorParameters<typeof Manager>[0]> = {}) {
    const fake = createFakeClock();
    const runner = fakeRunner();
    const delivered: JobResult[] = [];
    const manager = new Manager({
        run: runner.run,
        deliver: (result) => delivered.push(result),
        maxActive: 2,
        maxQueued: 3,
        clock: fake.clock,
        ...overrides,
    });
    return { manager, runner, delivered, fake };
}

describe("subagent Manager", () => {
    test("runs a spawned Job and delivers its result once", async () => {
        const { manager, runner, delivered } = setup();
        const job = manager.spawn(config());
        expect(job).toMatchObject({ id: "explorer_1", state: "running" });
        runner.started[0]!.resolve(ok("found it"));
        await settleEventLoop();
        expect(delivered).toEqual([
            expect.objectContaining({
                status: "completed",
                text: "found it",
                job: expect.objectContaining({ id: job.id }),
            }),
        ]);
        expect(manager.list()).toEqual([]);
    });

    test("queues beyond maxActive and starts oldest first", async () => {
        const { manager, runner } = setup({ maxActive: 1 });
        manager.spawn(config({ task: "a" }));
        const second = manager.spawn(config({ task: "b" }));
        const third = manager.spawn(config({ task: "c" }));
        expect(second.state).toBe("queued");
        expect(third.state).toBe("queued");
        runner.started[0]!.resolve(ok());
        await settleEventLoop();
        expect(runner.started.map(({ config }) => config.task)).toEqual(["a", "b"]);
        expect(manager.list().map(({ state }) => state)).toEqual(["running", "queued"]);
    });

    test("publishes snapshots as Jobs enter and leave the active set", async () => {
        const snapshots: string[][] = [];
        const { manager, runner } = setup({
            maxActive: 1,
            onChange: (jobs) => snapshots.push(jobs.map((job) => `${job.id}:${job.state}`)),
        });
        manager.spawn(config({ task: "a" }));
        manager.spawn(config({ task: "b" }));
        expect(snapshots.at(-1)).toEqual(["explorer_1:running", "explorer_2:queued"]);
        runner.started[0]!.resolve(ok());
        await settleEventLoop();
        expect(snapshots.at(-1)).toEqual(["explorer_2:running"]);
        runner.started[1]!.resolve(ok());
        await settleEventLoop();
        expect(snapshots.at(-1)).toEqual([]);
    });

    test("rejects a spawn when the queue is full", () => {
        const { manager } = setup({ maxActive: 1, maxQueued: 1 });
        manager.spawn(config());
        manager.spawn(config());
        expect(() => manager.spawn(config())).toThrow("queue is full");
    });

    test("cancels running and queued Jobs without delivery", async () => {
        const { manager, runner, delivered } = setup({ maxActive: 1 });
        const running = manager.spawn(config());
        const queued = manager.spawn(config());
        const queuedResult = await manager.cancel([queued.id]);
        expect(queuedResult[0]?.state).toBe("cancelled");
        const pendingRunning = manager.cancel([running.id]);
        expect(runner.started[0]!.signal.aborted).toBe(true);
        runner.started[0]!.reject(new Error("aborted"));
        expect((await pendingRunning)[0]?.state).toBe("cancelled");
        expect(delivered).toEqual([]);
    });

    test("delivers runner failures as failed Jobs", async () => {
        const { manager, runner, delivered } = setup();
        manager.spawn(config());
        runner.started[0]!.reject(new Error("model exploded"));
        await settleEventLoop();
        expect(delivered[0]).toMatchObject({ status: "failed", error: "model exploded" });
    });

    test("resets inactivity on activity and keeps the hard Limit absolute", async () => {
        const { manager, runner, delivered, fake } = setup();
        manager.spawn(config({ inactivityMs: 10_000, hardMs: 30_000 }));
        await fake.advance(9_000);
        runner.started[0]!.onActivity();
        await fake.advance(9_000);
        expect(runner.started[0]!.signal.aborted).toBe(false);
        runner.started[0]!.onActivity();
        await fake.advance(9_000);
        runner.started[0]!.onActivity();
        await fake.advance(3_000);
        expect(runner.started[0]!.signal.aborted).toBe(true);
        runner.started[0]!.resolve(ok("late text"));
        await settleEventLoop();
        expect(delivered[0]).toMatchObject({ status: "timed_out", text: "late text" });
        expect(delivered[0]?.error).toContain("hard limit of 30s");
    });

    test("times out a quiet Job on the inactivity Limit", async () => {
        const { manager, runner, delivered, fake } = setup();
        manager.spawn(config({ inactivityMs: 10_000 }));
        await fake.advance(10_000);
        expect(runner.started[0]!.signal.aborted).toBe(true);
        runner.started[0]!.reject(new Error("aborted"));
        await settleEventLoop();
        expect(delivered[0]?.status).toBe("timed_out");
        expect(delivered[0]?.error).toContain("no activity for 10s");
    });

    test("counts ids per Profile and validates all cancellation ids before acting", () => {
        const { manager, runner } = setup({ maxActive: 3 });
        const explorer = manager.spawn(config({ profile: "explorer" }));
        expect(manager.spawn(config({ profile: "worker" })).id).toBe("worker_1");
        expect(manager.spawn(config({ profile: "explorer" })).id).toBe("explorer_2");
        expect(() => manager.cancel([explorer.id, "missing_9"])).toThrow("Unknown subagent Job");
        expect(runner.started[0]!.signal.aborted).toBe(false);
    });

    test("isolates Job lifecycle from a throwing snapshot observer", async () => {
        const { manager, runner, delivered } = setup({
            onChange: () => {
                throw new Error("renderer failed");
            },
        });
        manager.spawn(config());
        runner.started[0]!.resolve(ok());
        await settleEventLoop();
        expect(delivered).toHaveLength(1);
        expect(manager.list()).toEqual([]);
    });

    test("shutdown gives up waiting for a runner that ignores abort", async () => {
        const { manager, runner, fake } = setup();
        manager.spawn(config());
        let settled = false;
        const shutdown = manager.shutdown().then(() => {
            settled = true;
        });
        expect(runner.started[0]!.signal.aborted).toBe(true);
        await fake.advance(5_000);
        await shutdown;
        expect(settled).toBe(true);
        expect(() => manager.spawn(config())).toThrow("shutting down");
    });

    test("does not deliver a timed-out runner that settles after shutdown", async () => {
        const { manager, runner, delivered, fake } = setup();
        manager.spawn(config({ inactivityMs: 10_000 }));
        await fake.advance(10_000);
        expect(runner.started[0]!.signal.aborted).toBe(true);

        const shutdown = manager.shutdown();
        await fake.advance(5_000);
        await shutdown;
        runner.started[0]!.resolve(ok("stale"));
        await settleEventLoop();

        expect(delivered).toEqual([]);
        expect(manager.list()).toEqual([]);
    });
});
