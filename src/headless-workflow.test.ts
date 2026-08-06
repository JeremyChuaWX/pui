import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowAgentExecutor, isHeadlessWorkflowSession } from "../extensions/workflow/agent-executor.js";
import { createWorkflowBackend, type WorkflowBackend } from "../extensions/workflow/backend.js";
import { WorkflowRunStorage } from "../extensions/workflow/run-storage.js";
import { parseHeadlessWorkflowArgs, runHeadlessWorkflow } from "./headless-workflow.js";

describe("headless workflows", () => {
    test("only recognizes generated headless session IDs", () => {
        expect(isHeadlessWorkflowSession("headless-7e2646bb-a375-4e8d-8a70-3c352d2e91cc")).toBe(true);
        expect(isHeadlessWorkflowSession("headless-user-session")).toBe(false);
        expect(isHeadlessWorkflowSession("headless-7e2646bb-a375-4e8d-8a70-3c352d2e91cc-extra")).toBe(false);
        expect(isHeadlessWorkflowSession("headless-7e2646bb-a375-1e8d-8a70-3c352d2e91cc")).toBe(false);
    });

    test("rejects inherited object properties as agent roles", async () => {
        const execute = createWorkflowAgentExecutor();
        await expect(
            execute({
                prompt: "test",
                role: "constructor",
                signal: new AbortController().signal,
                timeoutMs: 1_000,
                cwd: process.cwd(),
            }),
        ).rejects.toThrow("Agent role is not allowed by host policy: constructor");
    });

    test("parses cwd and JSON CLI arguments", () => {
        expect(parseHeadlessWorkflowArgs(["--cwd", "project", "answer.ts", '{"value":"hello world"}'], "/tmp")).toEqual(
            {
                path: "answer.ts",
                cwd: "/tmp/project",
                args: { value: "hello world" },
            },
        );
        expect(() => parseHeadlessWorkflowArgs(["answer.ts", "not-json"])).toThrow(
            "Workflow arguments must be valid JSON.",
        );
        expect(() => parseHeadlessWorkflowArgs(["answer.ts", "{}", "extra"])).toThrow("Usage: pui workflow");
    });

    test("runs a file without UI or session plumbing and returns its JSON result", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "answer.ts"),
                "export default async function answer(context: unknown, args: { value: number }) { return { answer: args.value } }\n",
            );
            const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
            try {
                await expect(
                    runHeadlessWorkflow({ path: "answer.ts", cwd: root, args: { value: 42 }, backend }),
                ).resolves.toEqual({
                    answer: 42,
                });
            } finally {
                await backend.shutdown();
            }
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("canonicalizes paths and rejects non-TypeScript files", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "answer.ts"),
                "export default async function answer() { return 42 }\n",
            );
            await fs.promises.symlink("answer.ts", path.join(root, "alias.js"));
            const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
            try {
                await expect(runHeadlessWorkflow({ path: "alias.js", cwd: root, backend })).resolves.toBe(42);

                await fs.promises.writeFile(
                    path.join(root, "answer.js"),
                    "export default async function answer() { return 42 }\n",
                );
                await expect(runHeadlessWorkflow({ path: "answer.js", cwd: root, backend })).rejects.toThrow(
                    "workflow files must use the .ts extension",
                );
            } finally {
                await backend.shutdown();
            }
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("reports phase, log, shell, and terminal progress", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-progress-"));
        const backend = createWorkflowBackend({
            agentExecutor: async () => ({ value: null }),
            shellExecutor: async () => ({ exitCode: 0, stdout: "checked", stderr: "" }),
        });
        try {
            await fs.promises.writeFile(
                path.join(root, "progress.ts"),
                'export default async function progress(context: any) { await context.phase("collect"); await context.log("Collecting inputs"); await context.shell("check"); return "done" }\n',
            );
            const progress: string[] = [];
            await expect(
                runHeadlessWorkflow({
                    path: "progress.ts",
                    cwd: root,
                    backend,
                    onProgress: (line) => progress.push(line),
                }),
            ).resolves.toBe("done");
            expect(progress).toEqual([
                "starting progress",
                expect.stringMatching(/^launched [0-9a-f]{8}$/),
                "phase: collect",
                "log: Collecting inputs",
                "shell: $ check",
                "completed",
            ]);
        } finally {
            await backend.shutdown();
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    }, 30_000);

    test("does not shut down supplied backends and unsubscribes when launch fails", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        let unsubscribed = 0;
        let shutdown = 0;
        try {
            await fs.promises.writeFile(
                path.join(root, "answer.ts"),
                "export default async function answer() { return 42 }\n",
            );
            const backend = {
                subscribe: () => () => unsubscribed++,
                launch: async () => {
                    throw new Error("launch failed");
                },
                shutdown: async () => {
                    shutdown++;
                },
            } as unknown as WorkflowBackend;

            await expect(runHeadlessWorkflow({ path: "answer.ts", cwd: root, backend })).rejects.toThrow(
                "launch failed",
            );
            expect(unsubscribed).toBe(1);
            expect(shutdown).toBe(0);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("recognizes timed-out runs", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "answer.ts"),
                "export default async function answer() { return null }\n",
            );
            const timedOutRun = {
                id: "timed",
                status: "timed_out",
                error: "deadline exceeded",
                phases: [],
                recentActivity: [],
                agents: [],
            };
            let notify: Parameters<WorkflowBackend["subscribe"]>[0] = () => {};
            let inspections = 0;
            const backend = {
                subscribe: (callback: Parameters<WorkflowBackend["subscribe"]>[0]) => {
                    notify = callback;
                    return () => {};
                },
                launch: async () => ({ runId: "timed" }),
                inspect: () => {
                    if (inspections++ === 0) {
                        queueMicrotask(() => notify(timedOutRun as unknown as Parameters<typeof notify>[0]));
                        return { run: { ...timedOutRun, status: "running", error: undefined }, script: "" };
                    }
                    return { run: timedOutRun, script: "" };
                },
                shutdown: async () => {},
            } as unknown as WorkflowBackend;
            await expect(runHeadlessWorkflow({ path: "answer.ts", cwd: root, backend })).rejects.toThrow(
                "deadline exceeded",
            );
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("inherits external Node startup failures", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "answer.ts"),
                "export default async function answer() { return 42 }\n",
            );
            const environment = {
                ...process.env,
                HOME: root,
                XDG_DATA_HOME: root,
                XDG_STATE_HOME: root,
                PUI_WORKFLOW_NODE: path.join(root, "missing-node"),
                PATH: "",
            };
            const backend = createWorkflowBackend({
                agentExecutor: createWorkflowAgentExecutor(environment),
                cooperativeExecutor: true,
                environment,
                storage: new WorkflowRunStorage(path.join(root, "workflow-runs")),
            });
            try {
                await expect(
                    runHeadlessWorkflow({ path: "answer.ts", cwd: root, environment, backend }),
                ).rejects.toThrow("Workflows require an external Node >=22.19");
            } finally {
                await backend.shutdown();
            }
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("CLI writes JSON to stdout and errors to stderr with a nonzero exit", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-cli-"));
        try {
            await Promise.all([
                fs.promises.writeFile(
                    path.join(root, "answer.ts"),
                    "export default async function answer(context: unknown, args: unknown) { return args }\n",
                ),
                fs.promises.writeFile(
                    path.join(root, "oversized.ts"),
                    'export default async function oversized(context: any) { return context.agent("x".repeat(8001)) }\n',
                ),
            ]);
            const invoke = (args: string[]) =>
                Bun.spawn(
                    [
                        process.execPath,
                        "--preload",
                        "@opentui/solid/preload",
                        path.join(import.meta.dir, "index.tsx"),
                        "workflow",
                        ...args,
                    ],
                    { cwd: root, env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" },
                );
            const success = invoke(["--cwd", root, "answer.ts", '{"hello":"world"}']);
            const [successStdout, successStderr, successExit] = await Promise.all([
                new Response(success.stdout).text(),
                new Response(success.stderr).text(),
                success.exited,
            ]);
            expect(successStdout).toBe('{"hello":"world"}\n');
            expect(successStderr).toContain("pui workflow: starting answer");
            expect(successStderr).toContain("pui workflow: completed");
            expect(successExit).toBe(0);

            const omitted = invoke(["answer.ts"]);
            const [omittedStdout, omittedStderr, omittedExit] = await Promise.all([
                new Response(omitted.stdout).text(),
                new Response(omitted.stderr).text(),
                omitted.exited,
            ]);
            expect(omittedStdout).toBe("null\n");
            expect(omittedStderr).toContain("pui workflow: completed");
            expect(omittedExit).toBe(0);

            const oversized = invoke(["oversized.ts"]);
            const [oversizedStdout, oversizedStderr, oversizedExit] = await Promise.all([
                new Response(oversized.stdout).text(),
                new Response(oversized.stderr).text(),
                oversized.exited,
            ]);
            expect(oversizedStdout).toBe("");
            expect(oversizedStderr).toContain("pui workflow: failed");
            expect(oversizedStderr).toContain("pui: Agent prompt exceeds the 8,000-byte limit (received 8,001 bytes).");
            expect(oversizedExit).toBe(1);

            const failure = invoke(["answer.ts", "not-json"]);
            const [failureStdout, failureStderr, failureExit] = await Promise.all([
                new Response(failure.stdout).text(),
                new Response(failure.stderr).text(),
                failure.exited,
            ]);
            expect(failureExit).toBe(1);
            expect(failureStdout).toBe("");
            expect(failureStderr).toContain("pui: Workflow arguments must be valid JSON.");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    }, 30_000);

    test("reports terminal workflow failures", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "failure.ts"),
                'export default async function failure() { throw new Error("headless failure") }\n',
            );
            const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
            try {
                await expect(runHeadlessWorkflow({ path: "failure.ts", cwd: root, backend })).rejects.toThrow(
                    "headless failure",
                );
            } finally {
                await backend.shutdown();
            }
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });
});
