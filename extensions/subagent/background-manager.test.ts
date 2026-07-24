import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BackgroundSubagentManager } from "./background-manager.ts";
import { createTerminalSubagentDetails, updateSubagentDetails } from "./protocol.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const cwd = path.dirname(fileURLToPath(import.meta.url));
const waitUntil = async (predicate: () => boolean) => {
    for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await Bun.sleep(2);
    }
    throw new Error("timeout");
};
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
        await fs.promises.rm(path.dirname(result.fullOutputPath), { recursive: true, force: true });
    });

    test("keeps settlement successful when host delivery throws", async () => {
        const manager = new BackgroundSubagentManager({
            semaphore: new AbortableSemaphore(1),
            emit: () => {},
            deliver: () => {
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
        await expect(manager.wait([job.id])).resolves.toEqual([
            expect.objectContaining({ id: job.id, status: "succeeded" }),
        ]);
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
