import { describe, expect, test } from "bun:test";
import { defineProfile } from "./profiles/profile.ts";
import { createInitialSubagentDetails, createTerminalSubagentDetails } from "./protocol.ts";
import { runSubagentJob } from "./run-job.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const details = () =>
    createInitialSubagentDetails({ id: "job-1", agent: "explorer", model: "fixture/model", cwd: "/repo", now: 1 });

function request(signal = new AbortController().signal) {
    const updates: string[] = [];
    return {
        updates,
        value: {
            details: details(),
            profile: defineProfile({
                name: "fixture",
                label: "Fixture",
                description: "fixture",
                promptSnippet: "fixture",
                promptGuidelines: [],
                tools: ["read"],
                defaultModel: "fixture/default",
                modelEnv: "PI_FIXTURE_MODEL",
                timeoutMs: 100,
                promptFlag: "--system-prompt",
                prompt: "Explore",
            }),
            model: "fixture/model",
            prompt: "Inspect",
            cwd: "/repo",
            signal,
            publish: (next: ReturnType<typeof details>) => updates.push(next.run.status),
            spill: { store: { savePath: async () => undefined }, maxLines: 1_000 },
        },
    };
}

describe("runSubagentJob", () => {
    test("wires child arguments and publishes queue, start, runner, and terminal snapshots", async () => {
        const fixture = request();
        let invocationArgs: string[] = [];
        const result = await runSubagentJob(
            {
                semaphore: new AbortableSemaphore(1),
                now: () => 2,
                invocation: (args) => {
                    invocationArgs = args;
                    return { command: "pi", args };
                },
                run: async (options) => {
                    const terminal = createTerminalSubagentDetails(options.details, {
                        status: "succeeded",
                        outputPreview: "done",
                    });
                    options.onSnapshot?.(terminal);
                    return { details: terminal, output: "done", stderr: "", exitCode: 0, signal: null };
                },
            },
            fixture.value,
        );

        expect(invocationArgs.at(-1)).toBe("Inspect");
        expect(fixture.updates).toEqual(["queued", "starting", "succeeded"]);
        expect(result.delivered).toBe("done");
        expect(result.details.run.status).toBe("succeeded");
    });

    test("cancelled queueing never invokes a child and synthesizes terminal details", async () => {
        const semaphore = new AbortableSemaphore(1);
        const release = await semaphore.acquire();
        const controller = new AbortController();
        const fixture = request(controller.signal);
        let invoked = false;
        const running = runSubagentJob(
            {
                semaphore,
                now: () => 2,
                invocation: () => {
                    invoked = true;
                    return { command: "pi", args: [] };
                },
                run: async () => {
                    throw new Error("must not run");
                },
            },
            fixture.value,
        );
        controller.abort();
        const result = await running;
        release();

        expect(invoked).toBe(false);
        expect(result.details.run.status).toBe("cancelled");
        expect(result.delivered).toContain("cancelled while queued");
    });
});
