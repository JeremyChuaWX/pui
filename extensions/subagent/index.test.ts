import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AbortableSemaphore } from "../shared/semaphore.ts";
import { createExtensionApiHarness } from "../test-support/extension-api.ts";
import { registerSubagentExtension } from "./index.ts";
import { createTerminalSubagentDetails, updateSubagentDetails } from "./protocol.ts";

const extensionCwd = path.dirname(fileURLToPath(import.meta.url));

function extensionHost() {
    const host = createExtensionApiHarness();
    return {
        ...host,
        pi: host.api,
        get tool() {
            return host.tool("subagent");
        },
        get sent() {
            return host.messages.map(([message, options]) => ({ message, options }));
        },
    };
}

function successRun(output = "delegated answer") {
    return async (options: any) => {
        let details = updateSubagentDetails(options.details, {
            status: "running",
            phase: "thinking",
            startedAt: options.details.run.startedAt ?? Date.now(),
        });
        options.onSnapshot?.(details);
        details = createTerminalSubagentDetails(details, { status: "succeeded", outputPreview: output });
        options.onSnapshot?.(details);
        return { details, output, stderr: "", exitCode: 0, signal: null };
    };
}

function execute(
    tool: any,
    id: string,
    options: {
        params?: { agent?: "worker" | "explore"; prompt: string; cwd: string; model?: string };
        signal?: AbortSignal;
        onUpdate?: (value: any) => void;
    } = {},
) {
    return tool.execute(
        id,
        options.params ?? { agent: "explore", prompt: "Inspect the target", cwd: extensionCwd },
        options.signal,
        options.onUpdate,
        { cwd: extensionCwd },
    );
}

function argumentAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
}

describe("subagent extension integration", () => {
    test("runs omitted agents without a bundled prompt or model", async () => {
        const host = extensionHost();
        let runnerOptions: any;
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            environment: {},
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                runnerOptions = options;
                return successRun()(options);
            },
        });

        const result = await execute(host.tool, "default-call", {
            params: { prompt: "Implement the target", cwd: extensionCwd },
        });

        expect(host.tool.parameters.required).toEqual(["prompt", "cwd"]);
        expect(host.tool.parameters.properties.agent.enum).toEqual(["worker", "explore"]);
        expect(result.details.run.agent).toBe("generic");
        expect(result.details.run.model).toBe("default");
        expect(argumentAfter(runnerOptions.args, "--tools")).toBe("read,bash,edit,write,grep,find,ls");
        expect(runnerOptions.args).not.toContain("--append-system-prompt");
        expect(runnerOptions.args).not.toContain("--system-prompt");
        expect(runnerOptions.args).not.toContain("--model");
        expect(runnerOptions.args.at(-1)).toBe("Implement the target");
        expect(runnerOptions.timeoutMs).toBe(600_000);

        const metadata = [host.tool.description, host.tool.promptSnippet, ...(host.tool.promptGuidelines ?? [])].join(
            "\n",
        );
        expect(metadata).toContain("Omitting agent uses no bundled agent prompt or model");
        expect(metadata).toContain("instead of bash launching headless Pi");
    });

    test("allows an explicit model without adding a prompt to an omitted-agent call", async () => {
        const host = extensionHost();
        let runnerOptions: any;
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            environment: { PI_WORKER_MODEL: "fixture/ignored-worker-model" },
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                runnerOptions = options;
                return successRun()(options);
            },
        });

        const result = await execute(host.tool, "default-explicit-model", {
            params: { prompt: "Implement the target", cwd: extensionCwd, model: "fixture/default-model" },
        });

        expect(result.details.run.agent).toBe("generic");
        expect(result.details.run.model).toBe("fixture/default-model");
        expect(argumentAfter(runnerOptions.args, "--model")).toBe("fixture/default-model");
        expect(runnerOptions.args).not.toContain("--append-system-prompt");
        expect(runnerOptions.args).not.toContain("--system-prompt");
    });

    test("preserves explicit explore behavior, outer id, isolation flags, and lifecycle snapshots", async () => {
        const host = extensionHost();
        let runnerOptions: any;
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(4),
            environment: {},
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                runnerOptions = options;
                return successRun()(options);
            },
        });
        const updates: any[] = [];

        const result = await execute(host.tool, "outer-call-42", {
            onUpdate: (update) => updates.push(update),
        });

        expect(result.details.run.id).toBe("outer-call-42");
        expect(result.details.run.agent).toBe("explore");
        expect(result.details.run.model).toBe("openai-codex/gpt-5.4-mini:off");
        expect(result.content[0].text).toBe("delegated answer");
        expect(updates.map((item) => item.details.run.status)).toEqual(["queued", "starting", "running", "succeeded"]);
        expect(updates.every((item) => item.details.run.id === "outer-call-42")).toBe(true);
        expect(runnerOptions.command).toBe("fake-pi");
        expect(runnerOptions.args).toContain("--mode");
        expect(runnerOptions.args).toContain("json");
        for (const flag of [
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
        ]) {
            expect(runnerOptions.args).toContain(flag);
        }
        expect(argumentAfter(runnerOptions.args, "--tools")).toBe("read,grep,find,ls");
        expect(argumentAfter(runnerOptions.args, "--model")).toBe("openai-codex/gpt-5.4-mini:off");
        expect(runnerOptions.args).toContain("--system-prompt");
        expect(runnerOptions.args).not.toContain("--append-system-prompt");
        expect(runnerOptions.timeoutMs).toBe(120_000);
        expect(runnerOptions.args.at(-1)).toBe("Inspect the target");
        expect(result.details.run.fullOutputPath).toBeUndefined();
    });

    test("uses bundled guidance for an explicit worker", async () => {
        const host = extensionHost();
        let runnerOptions: any;
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            environment: {},
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                runnerOptions = options;
                return successRun()(options);
            },
        });

        const result = await execute(host.tool, "explicit-worker", {
            params: { agent: "worker", prompt: "Implement the target", cwd: extensionCwd },
        });

        expect(result.details.run.agent).toBe("worker");
        expect(result.details.run.model).toBe("openai-codex/gpt-5.6-sol:low");
        expect(argumentAfter(runnerOptions.args, "--tools")).toBe("read,bash,edit,write,grep,find,ls");
        expect(runnerOptions.args).toContain("--append-system-prompt");
        const workerPrompt = argumentAfter(runnerOptions.args, "--append-system-prompt") ?? "";
        expect(workerPrompt).toContain("Lazy means efficient, not careless.");
        expect(workerPrompt).toContain("Bug fix = root cause, not symptom");
        expect(workerPrompt.toLowerCase()).not.toContain("ponytail");
        expect(runnerOptions.args).not.toContain("--system-prompt");
        expect(argumentAfter(runnerOptions.args, "--model")).toBe("openai-codex/gpt-5.6-sol:low");
        expect(runnerOptions.timeoutMs).toBe(600_000);
    });

    test("resolves worker models from explicit input, then PI_WORKER_MODEL", async () => {
        const host = extensionHost();
        const invocations: string[][] = [];
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            environment: { PI_WORKER_MODEL: "fixture/environment-model" },
            invocation: (args) => {
                invocations.push(args);
                return { command: "fake-pi", args };
            },
            run: successRun(),
        });

        const fromEnvironment = await execute(host.tool, "worker-environment-model", {
            params: { agent: "worker", prompt: "Implement one", cwd: extensionCwd },
        });
        const fromInput = await execute(host.tool, "worker-explicit-model", {
            params: {
                prompt: "Implement two",
                cwd: extensionCwd,
                model: "fixture/explicit-model",
            },
        });

        expect(fromEnvironment.details.run.model).toBe("fixture/environment-model");
        expect(argumentAfter(invocations[0]!, "--model")).toBe("fixture/environment-model");
        expect(fromInput.details.run.model).toBe("fixture/explicit-model");
        expect(argumentAfter(invocations[1]!, "--model")).toBe("fixture/explicit-model");
    });

    test("keeps lifecycle content renderer-neutral while child tools are active", async () => {
        const host = extensionHost();
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                const timestamp = Date.now();
                const previousSequence = options.details.run.recentActivity.at(-1)?.sequence ?? 0;
                let details = updateSubagentDetails(options.details, {
                    status: "running",
                    phase: "tool",
                    startedAt: options.details.run.startedAt ?? timestamp,
                    activeTools: [
                        { id: "child-read", name: "read", title: "read src/controller.ts", startedAt: timestamp },
                    ],
                    recentActivity: [
                        ...options.details.run.recentActivity,
                        {
                            sequence: previousSequence + 1,
                            timestamp,
                            kind: "tool_start",
                            title: "read src/controller.ts",
                        },
                    ],
                });
                options.onSnapshot?.(details);
                details = createTerminalSubagentDetails(details, { status: "succeeded", outputPreview: "done" });
                options.onSnapshot?.(details);
                return { details, output: "done", stderr: "", exitCode: 0, signal: null };
            },
        });
        const updates: any[] = [];
        await execute(host.tool, "active-tool-render", {
            onUpdate: (update) => updates.push(update),
        });
        const runningUpdate = updates.find((update) => update.details.run.activeTools.length > 0);
        expect(runningUpdate.content[0].text).toBe("explore subagent is running...");
    });

    test("registers blocking and background tools plus extension lifecycle handlers", () => {
        const host = extensionHost();
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: successRun(),
        });

        expect([...host.tools.keys()]).toEqual([
            "subagent_spawn",
            "subagent_wait",
            "subagent_check",
            "subagent_cancel",
            "subagent_list",
            "subagent",
        ]);
        expect(host.handlers.has("session_start")).toBe(true);
        expect(host.handlers.has("agent_settled")).toBe(true);
        expect(host.handlers.has("tool_result")).toBe(true);
        expect(host.handlers.has("session_shutdown")).toBe(true);
    });
});
