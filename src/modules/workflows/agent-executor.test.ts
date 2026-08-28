import { describe, expect, test } from "bun:test";
import { type ChildAgentResult, emptyChildAgentUsage } from "#shared/agent-runtime/child-agent.ts";
import { AbortableSemaphore } from "#shared/lib/semaphore.ts";
import { createWorkflowAgentExecutor } from "./agent-executor.ts";

function succeededResult(): ChildAgentResult {
    return {
        status: "succeeded",
        output: "done",
        stderr: "",
        exitCode: 0,
        signal: null,
        model: "fixture/model",
        usage: emptyChildAgentUsage(),
        outputPreview: "done",
    };
}

function agentRequest(overrides: Partial<{ role: string; signal: AbortSignal }> = {}) {
    return {
        prompt: "report",
        role: "generic",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        cwd: process.cwd(),
        ...overrides,
    };
}

describe("createWorkflowAgentExecutor", () => {
    test("waits for a process-wide child-Pi slot before running", async () => {
        const semaphore = new AbortableSemaphore(1);
        const hold = await semaphore.acquire();
        let ran = false;
        const executor = createWorkflowAgentExecutor(process.env, {
            semaphore,
            run: async () => {
                ran = true;
                return succeededResult();
            },
        });

        const pending = executor(agentRequest());
        await Bun.sleep(10);
        expect(ran).toBe(false);

        hold();
        const result = await pending;
        expect(ran).toBe(true);
        expect(result.value).toBe("done");
    });

    test("cancellation while queued rejects without running the child", async () => {
        const semaphore = new AbortableSemaphore(1);
        const hold = await semaphore.acquire();
        let ran = false;
        const executor = createWorkflowAgentExecutor(process.env, {
            semaphore,
            run: async () => {
                ran = true;
                return succeededResult();
            },
        });

        const controller = new AbortController();
        const pending = executor(agentRequest({ signal: controller.signal }));
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(ran).toBe(false);
        hold();
    });

    test("rejects a disallowed role before taking a slot", async () => {
        const semaphore = new AbortableSemaphore(1);
        const hold = await semaphore.acquire();
        const executor = createWorkflowAgentExecutor(process.env, { semaphore });

        await expect(executor(agentRequest({ role: "constructor" }))).rejects.toThrow(
            "Agent role is not allowed by host policy: constructor",
        );
        hold();
    });
});
