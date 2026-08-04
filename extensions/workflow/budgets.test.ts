import { describe, expect, test } from "bun:test";
import { type AgentExecutor, createWorkflowBackend, type WorkflowBackend } from "./backend.js";
import { parseWorkflowRunV1, type WorkflowRunSummaryV1 } from "./protocol.js";

async function waitFor(predicate: () => boolean, timeout = 2_000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > end) throw new Error("timeout");
        await Bun.sleep(5);
    }
}

const launch = (backend: WorkflowBackend, script: string, limits: Record<string, number> = {}) =>
    backend.launch({ name: "budgets", script, sessionId: "test", cwd: process.cwd(), limits });

function valid(backend: WorkflowBackend, runId: string): WorkflowRunSummaryV1 {
    const summary = backend.inspect(runId).run;
    expect(parseWorkflowRunV1(summary)).toEqual(summary);
    return summary;
}

describe("workflow budgets and pause", () => {
    test("caps concurrency and pause gates queued agents until resume", async () => {
        let active = 0;
        let peak = 0;
        let calls = 0;
        const releases: (() => void)[] = [];
        const executor: AgentExecutor = async ({ prompt }) => {
            calls++;
            active++;
            peak = Math.max(peak, active);
            try {
                if (calls <= 2) await new Promise<void>((resolve) => releases.push(resolve));
                return { value: prompt };
            } finally {
                active--;
            }
        };
        const backend = createWorkflowBackend({ agentExecutor: executor });
        const { runId } = await launch(
            backend,
            `return await parallel(Array.from({length:6},(_,i)=>agent(String(i),{role:"explore"})))`,
            { maxConcurrency: 2 },
        );
        await waitFor(() => calls === 2);
        await backend.control(runId, "pause");
        for (const release of releases) release();
        await waitFor(() => active === 0 && backend.inspect(runId).run.status === "paused");
        expect(calls).toBe(2);
        expect(valid(backend, runId).status).toBe("paused");
        await backend.control(runId, "resume");
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(calls).toBe(6);
        expect(peak).toBe(2);
        valid(backend, runId);
        await backend.shutdown();
    });

    test("enforces the agent cap and warns at 25 scheduled agents", async () => {
        const backend = createWorkflowBackend({ agentExecutor: async ({ prompt }) => ({ value: prompt }) });
        const capped = await launch(backend, `for(let i=0;i<3;i++) await agent(String(i),{role:"explore"})`, {
            maxAgents: 2,
        });
        await waitFor(() => backend.inspect(capped.runId).run.status === "failed");
        expect(valid(backend, capped.runId).error).toContain("agent cap exceeded");
        const large = await launch(backend, `for(let i=0;i<26;i++) await agent(String(i),{role:"explore"})`, {
            maxAgents: 26,
        });
        await waitFor(() => backend.inspect(large.runId).run.status === "succeeded");
        const summary = valid(backend, large.runId);
        expect(summary.agents).toHaveLength(26);
        expect(summary.warning).toContain("25 agents scheduled");
        await backend.shutdown();
    });

    test("bounds retries and enforces agent and run timeouts", async () => {
        let calls = 0;
        const retrying = createWorkflowBackend({
            agentExecutor: async () => {
                calls++;
                throw new Error("retry me");
            },
        });
        const retried = await launch(retrying, `await agent("x",{role:"explore",retries:99})`);
        await waitFor(() => retrying.inspect(retried.runId).run.status === "failed");
        expect(calls).toBe(4);
        valid(retrying, retried.runId);
        await retrying.shutdown();

        const timed = createWorkflowBackend({ agentExecutor: async () => await new Promise(() => {}) });
        const agentTimeout = await launch(timed, `await agent("x",{role:"explore",timeoutMs:20})`);
        await waitFor(() => timed.inspect(agentTimeout.runId).run.status === "failed");
        expect(valid(timed, agentTimeout.runId).agents[0]?.status).toBe("timed_out");
        await timed.shutdown();

        const total = createWorkflowBackend({
            platform: { runTimeoutMs: 25 },
            cooperativeExecutor: true,
            agentExecutor: ({ signal }) =>
                new Promise((_resolve, reject) =>
                    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
                ),
        });
        const runTimeout = await launch(total, `await agent("x",{role:"explore",timeoutMs:1000})`);
        await waitFor(() => total.inspect(runTimeout.runId).run.status === "failed");
        expect(valid(total, runTimeout.runId).error).toContain("run timed out");
        await total.shutdown();
    });

    test("retains consumed usage when token and cost budgets are exceeded", async () => {
        for (const [limits, usage, message] of [
            [{ maxTokens: 4 }, { totalTokens: 5, input: 5 }, "token budget exceeded"],
            [{ maxCost: 0.5 }, { cost: 0.75, totalTokens: 1 }, "cost budget exceeded"],
        ] as const) {
            const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: "done", usage }) });
            const { runId } = await launch(backend, `await agent("x",{role:"explore"})`, limits);
            await waitFor(() => backend.inspect(runId).run.status === "failed");
            const summary = valid(backend, runId);
            expect(summary.error).toContain(message);
            expect(summary.usage.totalTokens).toBe(usage.totalTokens);
            expect(summary.usage.cost).toBe(usage.cost ?? 0);
            await backend.shutdown();
        }
    });
});
