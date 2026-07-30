import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowBackend } from "../extensions/workflow/backend.js";
import { parseHeadlessWorkflowArgs, runHeadlessWorkflow } from "./headless-workflow.js";

describe("headless workflows", () => {
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
            await expect(
                runHeadlessWorkflow({ path: "answer.ts", cwd: root, args: { value: 42 }, backend }),
            ).resolves.toEqual({
                answer: 42,
            });
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
            await expect(runHeadlessWorkflow({ path: "alias.js", cwd: root, backend })).resolves.toBe(42);

            await fs.promises.writeFile(
                path.join(root, "answer.js"),
                "export default async function answer() { return 42 }\n",
            );
            await expect(runHeadlessWorkflow({ path: "answer.js", cwd: root, backend })).rejects.toThrow(
                "workflow files must use the .ts extension",
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
            await expect(
                runHeadlessWorkflow({
                    path: "answer.ts",
                    cwd: root,
                    environment: { ...process.env, PUI_WORKFLOW_NODE: path.join(root, "missing-node"), PATH: "" },
                }),
            ).rejects.toThrow("Workflows require an external Node >=22.19");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("CLI writes JSON to stdout and errors to stderr with a nonzero exit", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-cli-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "answer.ts"),
                "export default async function answer(context: unknown, args: unknown) { return args }\n",
            );
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
            expect(await new Response(success.stdout).text()).toBe('{"hello":"world"}\n');
            expect(await success.exited).toBe(0);

            const failure = invoke(["answer.ts", "not-json"]);
            expect(await failure.exited).toBe(1);
            expect(await new Response(failure.stderr).text()).toContain("pui: Workflow arguments must be valid JSON.");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    }, 15_000);

    test("reports terminal workflow failures", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-headless-"));
        try {
            await fs.promises.writeFile(
                path.join(root, "failure.ts"),
                'export default async function failure() { throw new Error("headless failure") }\n',
            );
            const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
            await expect(runHeadlessWorkflow({ path: "failure.ts", cwd: root, backend })).rejects.toThrow(
                "headless failure",
            );
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });
});
