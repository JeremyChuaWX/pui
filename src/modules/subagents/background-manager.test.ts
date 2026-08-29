import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor as waitUntil } from "#test-support/wait.js";
import { BackgroundSubagentManager } from "./background-manager.ts";
import { createTerminalSubagentJob, updateSubagentJob } from "./job-state.ts";
import worker from "./profiles/worker/index.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const cwd = path.dirname(fileURLToPath(import.meta.url));
/** The manager hands its Clock to the runner; the fake reads the same one instead of Date.now(). */
const now = (options: { clock?: { now(): number } }) => options.clock?.now() ?? Date.now();
function controlled(limit = 1) {
    const semaphore = new AbortableSemaphore(limit);
    const gates: Array<() => void> = [];
    const starts: string[] = [];
    const deliveries: any[] = [];
    const events: any[] = [];
    const manager = new BackgroundSubagentManager({
        semaphore,
        invocation: (args) => ({ command: "fake", args }),
        emit: (job, type) => events.push({ type, job }),
        deliver: (result) => deliveries.push(result),
        run: async (options) => {
            starts.push(options.job.id);
            let details = updateSubagentJob(options.job, { status: "running", phase: "thinking" }, now(options));
            options.onSnapshot?.(details);
            await new Promise<void>((resolve) => {
                gates.push(resolve);
                options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            details = createTerminalSubagentJob(
                details,
                options.signal?.aborted
                    ? { status: "cancelled", error: "cancelled" }
                    : { status: "succeeded", outputPreview: "done" },
                now(options),
            );
            options.onSnapshot?.(details);
            return { job: details, output: "done", stderr: "", exitCode: 0, signal: null };
        },
    });
    return {
        manager,
        semaphore,
        gates,
        starts,
        deliveries,
        events,
    };
}

describe("BackgroundSubagentManager", () => {
    test("spawn validates cwd and returns before the runner completes", async () => {
        const fixture = controlled();
        const job = await fixture.manager.spawn({ profile: worker, prompt: "Do work", cwd }, cwd);
        expect(job.state.status).toBe("queued");
        await waitUntil(() => fixture.starts.length === 1);
        expect(fixture.manager.check(job.id).state.status).toBe("running");
        fixture.gates[0]!();
        await fixture.manager.wait([job.id]);
    });

    test("uses FIFO semaphore queuing and queued cancellation never starts", async () => {
        const fixture = controlled(1);
        const first = await fixture.manager.spawn({ profile: worker, prompt: "first", cwd }, cwd);
        const second = await fixture.manager.spawn({ profile: worker, prompt: "second", cwd }, cwd);
        await waitUntil(() => fixture.semaphore.active === 1 && fixture.semaphore.queued === 1);
        expect(fixture.manager.check(second.id).state.status).toBe("queued");
        await fixture.manager.cancel([second.id]);
        expect(fixture.starts).toEqual([first.id]);
        fixture.gates[0]!();
        await fixture.manager.wait([first.id]);
    });

    test("an aborted wait leaves running work alive", async () => {
        const fixture = controlled();
        const job = await fixture.manager.spawn({ profile: worker, prompt: "work", cwd }, cwd);
        await waitUntil(() => fixture.starts.length === 1);
        const abort = new AbortController();
        const waiting = fixture.manager.wait([job.id], abort.signal);
        abort.abort();
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        expect(fixture.manager.check(job.id).state.status).toBe("running");
        fixture.gates[0]!();
        await fixture.manager.wait([job.id]);
    });

    test("a wait aborted during terminal spill delivers exactly once", async () => {
        const abort = new AbortController();
        const deliveries: any[] = [];
        let finish!: () => void;
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake", args }),
            deliver: (result) => deliveries.push(result),
            emit: (job) => {
                if (job.state.status === "succeeded") abort.abort();
            },
            run: async (options) => {
                await new Promise<void>((resolve) => (finish = resolve));
                const details = createTerminalSubagentJob(options.job, { status: "succeeded" }, now(options));
                options.onSnapshot?.(details);
                return { job: details, output: "x".repeat(20_000), stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ profile: worker, prompt: "race", cwd }, cwd);
        const waiting = manager.wait([job.id], abort.signal);
        await waitUntil(() => finish !== undefined);
        finish();
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        await waitUntil(() => deliveries.length === 1);
        expect(deliveries.map((result) => result.id)).toEqual([job.id]);
        expect(deliveries[0].fullOutputPath).toBeString();
        expect(await manager.wait([job.id])).toEqual([]);
        expect(deliveries).toHaveLength(1);
        expect(manager.check(job.id).state.status).toBe("succeeded");
        await manager.shutdown();
    });

    test("multiple successful waiters consume one terminal result without automatic delivery", async () => {
        const fixture = controlled();
        const job = await fixture.manager.spawn({ profile: worker, prompt: "shared wait", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 1);
        const first = fixture.manager.wait([job.id]);
        const second = fixture.manager.wait([job.id]);
        fixture.gates[0]!();
        expect((await first)[0]?.id).toBe(job.id);
        expect((await second)[0]?.id).toBe(job.id);
        expect(fixture.deliveries).toHaveLength(0);
    });

    test("a waited Job is never delivered; an unwaited Job is delivered exactly once on settlement", async () => {
        const fixture = controlled();
        const waited = await fixture.manager.spawn({ profile: worker, prompt: "waited", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 1);
        const waiting = fixture.manager.wait([waited.id]);
        fixture.gates[0]!();
        await waiting;
        expect(fixture.deliveries).toHaveLength(0);

        const unwaited = await fixture.manager.spawn({ profile: worker, prompt: "unwaited", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 2);
        fixture.gates[1]!();
        await waitUntil(() => fixture.manager.check(unwaited.id).state.status === "succeeded");
        expect(fixture.deliveries.map((item) => item.id)).toEqual([unwaited.id]);
        expect(await fixture.manager.wait([unwaited.id])).toEqual([]);
        expect(fixture.deliveries).toHaveLength(1);
    });

    test("shutdown aborts running Jobs and delivers nothing for them", async () => {
        const fixture = controlled();
        const finished = await fixture.manager.spawn({ profile: worker, prompt: "finished", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 1);
        fixture.gates[0]!();
        await waitUntil(() => fixture.deliveries.length === 1);
        expect(fixture.deliveries[0].id).toBe(finished.id);

        const aborted = await fixture.manager.spawn({ profile: worker, prompt: "shutdown", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 2);
        await fixture.manager.shutdown(100);
        expect(fixture.manager.check(aborted.id).state.status).toBe("cancelled");
        expect(fixture.deliveries).toHaveLength(1);
    });

    test("bounds automatic delivery, marks truncation, and preserves a private full-output file", async () => {
        const deliveries: any[] = [];
        const output = "x".repeat(20_000);
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: (value) => deliveries.push(value),
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentJob(options.job, { status: "succeeded" }, now(options));
                return { job: details, output, stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ profile: worker, prompt: "large output", cwd }, cwd);
        await waitUntil(() => deliveries.length === 1);
        const result = deliveries[0];
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(12 * 1024);
        expect(result.text).toContain("[Output truncated:");
        expect(result.text).toContain("Complete output retained at:");
        expect(result.fullOutputPath).toBeString();
        expect(await fs.promises.readFile(result.fullOutputPath, "utf8")).toBe(output);
        expect((await fs.promises.stat(result.fullOutputPath)).mode & 0o777).toBe(0o600);
        expect((await fs.promises.stat(path.dirname(result.fullOutputPath))).mode & 0o777).toBe(0o700);
        await manager.wait([job.id]);
        await manager.shutdown();
        await expect(fs.promises.stat(result.fullOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("copies producer-bounded snapshots without applying a second truncation policy", async () => {
        const model = "m".repeat(300);
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: () => {},
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentJob(options.job, { status: "succeeded", model }, now(options));
                return { job: details, output: "done", stderr: "", exitCode: 0, signal: null };
            },
        });

        const spawned = await manager.spawn({ profile: worker, prompt: "copy boundary", cwd }, cwd);
        const [result] = await manager.wait([spawned.id]);
        expect(result?.id).toBe(spawned.id);
        expect(result?.status).toBe("succeeded");
        expect(result?.text).toBe("done");
        expect(manager.check(spawned.id).state.model).toBe(model);
        expect(manager.list()[0]?.state.model).toBe(model);
        await manager.shutdown();
    });

    test("shutdown overlapping settlement cannot spill afterward and does not remove runner-owned output", async () => {
        const externalDirectory = await fs.promises.mkdtemp(path.join(cwd, ".external-output-"));
        const externalPath = path.join(externalDirectory, "runner.md");
        await fs.promises.writeFile(externalPath, "runner-owned");
        let finish!: () => void;
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: () => {},
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                await new Promise<void>((resolve) => (finish = resolve));
                const details = createTerminalSubagentJob(
                    options.job,
                    {
                        status: "succeeded",
                        fullOutputPath: externalPath,
                    },
                    now(options),
                );
                return { job: details, output: "x".repeat(20_000), stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ profile: worker, prompt: "shutdown race", cwd }, cwd);
        await waitUntil(() => finish !== undefined);
        await manager.shutdown(0);
        finish();
        await waitUntil(() => manager.check(job.id).state.status === "succeeded");
        expect(manager.check(job.id).state.fullOutputPath).toBe(externalPath);
        expect(await fs.promises.readFile(externalPath, "utf8")).toBe("runner-owned");
        await fs.promises.rm(externalDirectory, { recursive: true, force: true });
    });

    test("keeps settlement successful when host delivery throws", async () => {
        let deliveryAttempts = 0;
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: () => {
                deliveryAttempts++;
                throw new Error("host unavailable");
            },
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentJob(options.job, { status: "succeeded" }, now(options));
                return { job: details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ profile: worker, prompt: "deliver", cwd }, cwd);
        await waitUntil(() => deliveryAttempts === 1);
        await expect(manager.cancel([job.id])).resolves.toEqual([
            expect.objectContaining({ id: job.id, state: expect.objectContaining({ status: "succeeded" }) }),
        ]);
        await expect(manager.wait([job.id])).resolves.toEqual([]);
        expect(deliveryAttempts).toBe(1);
    });

    test("host emit exceptions cannot reject settlement, cancellation, shutdown, or pruning", async () => {
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(64),
            emit: () => {
                throw new Error("host UI unavailable");
            },
            deliver: () => {},
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentJob(
                    options.job,
                    {
                        status: options.signal?.aborted ? "cancelled" : "succeeded",
                    },
                    now(options),
                );
                return { job: details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const first = await manager.spawn({ profile: worker, prompt: "emit", cwd }, cwd);
        await expect(manager.wait([first.id])).resolves.toHaveLength(1);
        for (let index = 0; index < 64; index++)
            await manager.spawn({ profile: worker, prompt: `prune ${index}`, cwd }, cwd);
        await waitUntil(() => manager.list().every((job) => job.state.status === "succeeded"));
        expect(manager.list()).toHaveLength(64);
        const cancelled = await manager.spawn({ profile: worker, prompt: "cancel", cwd }, cwd);
        await expect(manager.cancel([cancelled.id])).resolves.toHaveLength(1);
        await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    test("never tracks more than 64 active or queued jobs", async () => {
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: () => {},
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                await new Promise<void>((resolve) =>
                    options.signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                const details = createTerminalSubagentJob(
                    options.job,
                    {
                        status: "cancelled",
                        error: "cancelled",
                    },
                    now(options),
                );
                return { job: details, output: "", stderr: "", exitCode: null, signal: "SIGTERM" };
            },
        });
        for (let index = 0; index < 64; index++)
            await manager.spawn({ profile: worker, prompt: `active ${index}`, cwd }, cwd);
        expect(manager.list()).toHaveLength(64);
        await expect(manager.spawn({ profile: worker, prompt: "one too many", cwd }, cwd)).rejects.toThrow(
            "more than 64",
        );
        await manager.shutdown(500);
    });

    test("does not prune a terminal snapshot before its result is ready", async () => {
        let runCount = 0;
        let releaseSave!: () => void;
        let saveStarted = false;
        const deliveries: any[] = [];
        const semaphore = new AbortableSemaphore(64);
        const manager = new BackgroundSubagentManager({
            semaphore,
            emit: () => {},
            deliver: (value) => deliveries.push(value),
            invocation: (args) => ({ command: "fake", args }),
            outputStore: {
                savePath: async () => {
                    saveStarted = true;
                    await new Promise<void>((resolve) => (releaseSave = resolve));
                    return "/tmp/full-output";
                },
                cleanup: async () => {},
            },
            run: async (options) => {
                const index = runCount++;
                if (index > 0)
                    await new Promise<void>((resolve) =>
                        options.signal?.addEventListener("abort", () => resolve(), { once: true }),
                    );
                const details = createTerminalSubagentJob(
                    options.job,
                    {
                        status: options.signal?.aborted ? "cancelled" : "succeeded",
                    },
                    now(options),
                );
                return {
                    job: details,
                    output: index === 0 ? "x".repeat(20_000) : "ok",
                    stderr: "",
                    exitCode: 0,
                    signal: null,
                };
            },
        });
        try {
            const first = await manager.spawn({ profile: worker, prompt: "spill", cwd }, cwd);
            await waitUntil(() => saveStarted);
            for (let index = 0; index < 63; index++)
                await manager.spawn({ profile: worker, prompt: `active ${index}`, cwd }, cwd);
            await waitUntil(() => semaphore.active === 63);

            await expect(manager.spawn({ profile: worker, prompt: "must not prune spill", cwd }, cwd)).rejects.toThrow(
                "more than 64",
            );
            expect(manager.check(first.id).state.status).toBe("succeeded");
            expect(semaphore.active).toBe(63);
            const waiting = manager.wait([first.id]);
            releaseSave();
            expect((await waiting).map((result) => result.id)).toEqual([first.id]);
            expect(deliveries).toHaveLength(0);
        } finally {
            releaseSave?.();
            await manager.shutdown();
        }
    });

    test("prunes oldest terminal jobs above 64", async () => {
        const deliveries: any[] = [];
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(64),
            emit: () => {},
            deliver: (value) => deliveries.push(value),
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentJob(options.job, { status: "succeeded" }, now(options));
                return { job: details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const ids: string[] = [];
        for (let index = 0; index < 65; index++)
            ids.push((await manager.spawn({ profile: worker, prompt: `job ${index}`, cwd }, cwd)).id);
        await waitUntil(() => manager.list().every((job) => job.state.status === "succeeded"));
        expect(manager.list()).toHaveLength(64);
        expect(() => manager.check(ids[0]!)).toThrow("Unknown");
    });
});
