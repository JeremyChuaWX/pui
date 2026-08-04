import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor as waitUntil } from "../test-support/wait.js";
import { BackgroundSubagentManager } from "./background-manager.ts";
import { createTerminalSubagentDetails, updateSubagentDetails } from "./protocol.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const cwd = path.dirname(fileURLToPath(import.meta.url));
function controlled(limit = 1) {
    const semaphore = new AbortableSemaphore(limit);
    const gates: Array<() => void> = [];
    const starts: string[] = [];
    const deliveries: any[] = [];
    const events: any[] = [];
    let idle = false;
    const manager = new BackgroundSubagentManager({
        semaphore,
        invocation: (args) => ({ command: "fake", args }),
        emit: (job, type) => events.push({ type, job }),
        deliver: (result) => deliveries.push(result),
        isIdle: () => idle,
        run: async (options) => {
            starts.push(options.details.run.id);
            let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
            options.onSnapshot?.(details);
            await new Promise<void>((resolve) => {
                gates.push(resolve);
                options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            details = createTerminalSubagentDetails(
                details,
                options.signal?.aborted
                    ? { status: "cancelled", error: "cancelled" }
                    : { status: "succeeded", outputPreview: "done" },
            );
            options.onSnapshot?.(details);
            return { details, output: "done", stderr: "", exitCode: 0, signal: null };
        },
    });
    return {
        manager,
        semaphore,
        gates,
        starts,
        deliveries,
        events,
        setIdle(value: boolean) {
            idle = value;
        },
    };
}

describe("BackgroundSubagentManager", () => {
    test("spawn validates cwd and returns before the runner completes", async () => {
        const fixture = controlled();
        const job = await fixture.manager.spawn({ prompt: "Do work", cwd }, cwd);
        expect(job.run.status).toBe("queued");
        await waitUntil(() => fixture.starts.length === 1);
        expect(fixture.manager.check(job.id).run.status).toBe("running");
        fixture.gates[0]!();
        await fixture.manager.wait([job.id]);
    });

    test("uses FIFO semaphore queuing and queued cancellation never starts", async () => {
        const fixture = controlled(1);
        const first = await fixture.manager.spawn({ prompt: "first", cwd }, cwd);
        const second = await fixture.manager.spawn({ prompt: "second", cwd }, cwd);
        await waitUntil(() => fixture.semaphore.active === 1 && fixture.semaphore.queued === 1);
        expect(fixture.manager.check(second.id).run.status).toBe("queued");
        await fixture.manager.cancel([second.id]);
        expect(fixture.starts).toEqual([first.id]);
        fixture.gates[0]!();
        await fixture.manager.wait([first.id]);
    });

    test("an aborted wait leaves running work alive", async () => {
        const fixture = controlled();
        const job = await fixture.manager.spawn({ prompt: "work", cwd }, cwd);
        await waitUntil(() => fixture.starts.length === 1);
        const abort = new AbortController();
        const waiting = fixture.manager.wait([job.id], abort.signal);
        abort.abort();
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        expect(fixture.manager.check(job.id).run.status).toBe("running");
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
            isIdle: () => true,
            deliver: (result) => deliveries.push(result),
            emit: (job) => {
                if (job.run.status === "succeeded") abort.abort();
            },
            run: async (options) => {
                await new Promise<void>((resolve) => (finish = resolve));
                const details = createTerminalSubagentDetails(options.details, { status: "succeeded" });
                options.onSnapshot?.(details);
                return { details, output: "x".repeat(20_000), stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ prompt: "race", cwd }, cwd);
        const waiting = manager.wait([job.id], abort.signal);
        await waitUntil(() => finish !== undefined);
        finish();
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        await waitUntil(() => deliveries.length === 1);
        expect(deliveries.map((result) => result.id)).toEqual([job.id]);
        expect(deliveries[0].fullOutputPath).toBeString();
        expect(await manager.wait([job.id])).toEqual([]);
        manager.flushDeferred();
        expect(deliveries).toHaveLength(1);
        expect(manager.check(job.id).run.status).toBe("succeeded");
        await manager.shutdown();
    });

    test("multiple successful waiters consume one terminal result without automatic delivery", async () => {
        const fixture = controlled();
        fixture.setIdle(true);
        const job = await fixture.manager.spawn({ prompt: "shared wait", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 1);
        const first = fixture.manager.wait([job.id]);
        const second = fixture.manager.wait([job.id]);
        fixture.gates[0]!();
        expect((await first)[0]?.id).toBe(job.id);
        expect((await second)[0]?.id).toBe(job.id);
        fixture.manager.flushDeferred();
        expect(fixture.deliveries).toHaveLength(0);
    });

    test("deferred flushing cannot race an active successful waiter", async () => {
        const deliveries: any[] = [];
        let finish!: () => void;
        let manager!: BackgroundSubagentManager;
        manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake", args }),
            isIdle: () => true,
            deliver: (result) => deliveries.push(result),
            emit: (job) => {
                if (job.run.status === "succeeded") queueMicrotask(() => manager.flushDeferred());
            },
            run: async (options) => {
                await new Promise<void>((resolve) => (finish = resolve));
                const details = createTerminalSubagentDetails(options.details, { status: "succeeded" });
                return { details, output: "done", stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ prompt: "wait flush race", cwd }, cwd);
        await waitUntil(() => finish !== undefined);
        const waiting = manager.wait([job.id]);
        finish();
        expect((await waiting)[0]?.id).toBe(job.id);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(deliveries).toHaveLength(0);
    });

    test("wait interest consumes delivery and deferred results flush exactly once", async () => {
        const fixture = controlled();
        const waited = await fixture.manager.spawn({ prompt: "waited", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 1);
        const waiting = fixture.manager.wait([waited.id]);
        fixture.gates[0]!();
        await waiting;
        fixture.manager.flushDeferred();
        expect(fixture.deliveries).toHaveLength(0);

        const deferred = await fixture.manager.spawn({ prompt: "deferred", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 2);
        fixture.gates[1]!();
        await waitUntil(() => fixture.manager.check(deferred.id).run.status === "succeeded");
        fixture.manager.flushDeferred();
        fixture.manager.flushDeferred();
        expect(fixture.deliveries.map((item) => item.id)).toEqual([deferred.id]);
    });

    test("idle settlement delivers immediately and shutdown suppresses stale delivery", async () => {
        const fixture = controlled();
        fixture.setIdle(true);
        const immediate = await fixture.manager.spawn({ prompt: "immediate", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 1);
        fixture.gates[0]!();
        await waitUntil(() => fixture.deliveries.length === 1);
        expect(fixture.deliveries[0].id).toBe(immediate.id);

        fixture.setIdle(false);
        await fixture.manager.spawn({ prompt: "shutdown", cwd }, cwd);
        await waitUntil(() => fixture.gates.length === 2);
        await fixture.manager.shutdown(100);
        fixture.manager.flushDeferred();
        expect(fixture.deliveries).toHaveLength(1);
    });

    test("bounds automatic delivery, marks truncation, and preserves a private full-output file", async () => {
        const deliveries: any[] = [];
        const output = "x".repeat(20_000);
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: (value) => deliveries.push(value),
            isIdle: () => true,
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentDetails(options.details, { status: "succeeded" });
                return { details, output, stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ prompt: "large output", cwd }, cwd);
        await waitUntil(() => deliveries.length === 1);
        const result = deliveries[0];
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(12 * 1024);
        expect(result.text).toContain("Output truncated for delivery");
        expect(result.fullOutputPath).toBeString();
        expect(await fs.promises.readFile(result.fullOutputPath, "utf8")).toBe(output);
        expect((await fs.promises.stat(result.fullOutputPath)).mode & 0o777).toBe(0o600);
        expect((await fs.promises.stat(path.dirname(result.fullOutputPath))).mode & 0o777).toBe(0o700);
        await manager.wait([job.id]);
        await manager.shutdown();
        await expect(fs.promises.stat(result.fullOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
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
                const details = createTerminalSubagentDetails(options.details, {
                    status: "succeeded",
                    fullOutputPath: externalPath,
                });
                return { details, output: "x".repeat(20_000), stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ prompt: "shutdown race", cwd }, cwd);
        await waitUntil(() => finish !== undefined);
        await manager.shutdown(0);
        finish();
        await waitUntil(() => manager.check(job.id).run.status === "succeeded");
        expect(manager.check(job.id).run.fullOutputPath).toBe(externalPath);
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
            isIdle: () => true,
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentDetails(options.details, { status: "succeeded" });
                return { details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const job = await manager.spawn({ prompt: "deliver", cwd }, cwd);
        await waitUntil(() => deliveryAttempts === 1);
        await expect(manager.cancel([job.id])).resolves.toEqual([
            expect.objectContaining({ id: job.id, run: expect.objectContaining({ status: "succeeded" }) }),
        ]);
        expect(() => manager.flushDeferred()).not.toThrow();
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
            isIdle: () => true,
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentDetails(options.details, {
                    status: options.signal?.aborted ? "cancelled" : "succeeded",
                });
                return { details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const first = await manager.spawn({ prompt: "emit", cwd }, cwd);
        await expect(manager.wait([first.id])).resolves.toHaveLength(1);
        for (let index = 0; index < 64; index++) await manager.spawn({ prompt: `prune ${index}`, cwd }, cwd);
        await waitUntil(() => manager.list().every((job) => job.run.status === "succeeded"));
        expect(manager.list()).toHaveLength(64);
        const cancelled = await manager.spawn({ prompt: "cancel", cwd }, cwd);
        await expect(manager.cancel([cancelled.id])).resolves.toHaveLength(1);
        await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    test("never tracks more than 64 active or queued jobs", async () => {
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: () => {},
            isIdle: () => false,
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                await new Promise<void>((resolve) =>
                    options.signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                const details = createTerminalSubagentDetails(options.details, {
                    status: "cancelled",
                    error: "cancelled",
                });
                return { details, output: "", stderr: "", exitCode: null, signal: "SIGTERM" };
            },
        });
        for (let index = 0; index < 64; index++) await manager.spawn({ prompt: `active ${index}`, cwd }, cwd);
        expect(manager.list()).toHaveLength(64);
        await expect(manager.spawn({ prompt: "one too many", cwd }, cwd)).rejects.toThrow("more than 64");
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
            isIdle: () => true,
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
                const details = createTerminalSubagentDetails(options.details, {
                    status: options.signal?.aborted ? "cancelled" : "succeeded",
                });
                return {
                    details,
                    output: index === 0 ? "x".repeat(20_000) : "ok",
                    stderr: "",
                    exitCode: 0,
                    signal: null,
                };
            },
        });
        try {
            const first = await manager.spawn({ prompt: "spill", cwd }, cwd);
            await waitUntil(() => saveStarted);
            for (let index = 0; index < 63; index++) await manager.spawn({ prompt: `active ${index}`, cwd }, cwd);
            await waitUntil(() => semaphore.active === 63);

            await expect(manager.spawn({ prompt: "must not prune spill", cwd }, cwd)).rejects.toThrow("more than 64");
            expect(manager.check(first.id).run.status).toBe("succeeded");
            expect(semaphore.active).toBe(63);
            const waiting = manager.wait([first.id]);
            releaseSave();
            expect((await waiting).map((result) => result.id)).toEqual([first.id]);
            manager.flushDeferred();
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
            isIdle: () => true,
            invocation: (args) => ({ command: "fake", args }),
            run: async (options) => {
                const details = createTerminalSubagentDetails(options.details, { status: "succeeded" });
                return { details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const ids: string[] = [];
        for (let index = 0; index < 65; index++)
            ids.push((await manager.spawn({ prompt: `job ${index}`, cwd }, cwd)).id);
        await waitUntil(() => manager.list().every((job) => job.run.status === "succeeded"));
        expect(manager.list()).toHaveLength(64);
        expect(() => manager.check(ids[0]!)).toThrow("Unknown");
    });
});
