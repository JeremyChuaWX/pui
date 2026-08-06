import { describe, expect, test } from "bun:test";
import { AbortableSemaphore } from "../shared/semaphore.js";
import { type DurableOperationRun, runDurableOperation } from "./rpc-operations.js";

function makeRun(limit = 1): DurableOperationRun {
    return {
        controller: new AbortController(),
        semaphore: new AbortableSemaphore(limit),
        cooperativeTasks: new Set(),
        completions: new Map(),
    };
}

const baseOperation = (run: DurableOperationRun) => ({
    run,
    operationId: "op-1",
    timeoutMs: 5_000,
    timeoutMessage: "Operation timed out.",
    cooperative: false,
    now: () => 0,
    validateResult: (result: unknown) => result,
});

describe("runDurableOperation", () => {
    test("a throwing cleanup does not replace the operation's own error", async () => {
        const run = makeRun();
        await expect(
            runDurableOperation({
                ...baseOperation(run),
                execute: async () => {
                    throw new Error("operation failed");
                },
                cleanup: async () => {
                    throw new Error("cleanup failed");
                },
            }),
        ).rejects.toThrow("operation failed");
    });

    test("a throwing cleanup surfaces when the operation itself succeeded", async () => {
        const run = makeRun();
        await expect(
            runDurableOperation({
                ...baseOperation(run),
                execute: async () => "ok",
                cleanup: async () => {
                    throw new Error("cleanup failed");
                },
            }),
        ).rejects.toThrow("cleanup failed");
    });

    test("a throwing onSettled subscriber does not leak the semaphore permit", async () => {
        const run = makeRun();
        await expect(
            runDurableOperation({
                ...baseOperation(run),
                execute: async () => "ok",
                onSettled: () => {
                    throw new Error("subscriber failed");
                },
            }),
        ).rejects.toThrow("subscriber failed");
        expect(run.semaphore.active).toBe(0);
        const next = await runDurableOperation({
            ...baseOperation(run),
            operationId: "op-2",
            execute: async () => "next",
        });
        expect(next).toBe("next");
    });
});
