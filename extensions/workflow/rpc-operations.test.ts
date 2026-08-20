import { describe, expect, test } from "bun:test";
import { AbortableSemaphore } from "../shared/semaphore.js";
import { defaultWorkflowPolicy } from "./agent-executor.js";
import { type DurableOperationRun, runDurableOperation, validateAgentRequest } from "./rpc-operations.js";

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

describe("validateAgentRequest timeout defaults", () => {
    const agentPayload = (options: Record<string, unknown>) => ({ prompt: "look around", options });

    test("takes the preset default from the host policy when the workflow requests none", () => {
        const context = { policy: defaultWorkflowPolicy({}), activeSharedWriters: 0 };
        expect(validateAgentRequest(agentPayload({ role: "explore" }), context).timeoutMs).toBe(120_000);
        expect(validateAgentRequest(agentPayload({ role: "worker" }), context).timeoutMs).toBe(600_000);
    });

    test("keeps an explicit workflow timeout over the preset default", () => {
        const context = { policy: defaultWorkflowPolicy({}), activeSharedWriters: 0 };
        const request = validateAgentRequest(agentPayload({ role: "explore", timeoutMs: 5_000 }), context);
        expect(request.timeoutMs).toBe(5_000);
    });

    test("falls back to the workflow limit without a policy default", () => {
        const context = { activeSharedWriters: 0 };
        expect(validateAgentRequest(agentPayload({ role: "explore" }), context).timeoutMs).toBe(600_000);
    });
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
