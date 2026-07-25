import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
    BACKGROUND_SUBAGENT_VERSION,
} from "./background-protocol.ts";
import { registerSubagentExtension } from "./index.ts";
import { createTerminalSubagentDetails, updateSubagentDetails } from "./protocol.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const extensionCwd = path.dirname(fileURLToPath(import.meta.url));

type Handler = (event: any, ctx?: any) => any;

function fakePi() {
    let tool: any;
    const tools = new Map<string, any>();
    const handlers = new Map<string, Handler[]>();
    const busHandlers = new Map<string, Set<(payload: any) => void>>();
    const emitted: Array<{ channel: string; payload: any }> = [];
    const sent: Array<{ message: any; options: any }> = [];
    const events = {
        emit(channel: string, payload: any) {
            emitted.push({ channel, payload });
            for (const handler of busHandlers.get(channel) ?? []) handler(payload);
        },
        on(channel: string, handler: (payload: any) => void) {
            const listeners = busHandlers.get(channel) ?? new Set();
            listeners.add(handler);
            busHandlers.set(channel, listeners);
            return () => listeners.delete(handler);
        },
    };
    const pi = {
        events,
        sendMessage(message: any, options: any) {
            sent.push({ message, options });
        },
        registerTool(definition: any) {
            tool = definition;
            tools.set(definition.name, definition);
        },
        on(name: string, handler: Handler) {
            handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
    };
    return {
        pi: pi as any,
        get tool() {
            return tool;
        },
        tools,
        events,
        emitted,
        sent,
        listenerCount(channel: string) {
            return busHandlers.get(channel)?.size ?? 0;
        },
        handler(name: string) {
            const found = handlers.get(name)?.[0];
            if (!found) throw new Error(`Missing ${name} handler`);
            return found;
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
        await Bun.sleep(2);
    }
}

describe("subagent extension integration", () => {
    test("runs omitted agents without a bundled prompt or model", async () => {
        const host = fakePi();
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

        const metadata = [host.tool.description, host.tool.promptSnippet, ...host.tool.promptGuidelines].join("\n");
        expect(metadata).toContain("Omitting agent uses no bundled agent prompt or model");
        expect(metadata).toContain("instead of bash launching headless Pi");
    });

    test("allows an explicit model without adding a prompt to an omitted-agent call", async () => {
        const host = fakePi();
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
        const host = fakePi();
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
        const host = fakePi();
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
        const host = fakePi();
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
        const host = fakePi();
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

    test("stores full output privately only when model-visible output is truncated", async () => {
        const host = fakePi();
        const output = "😀".repeat(20_000);
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: successRun(output),
        });

        const result = await execute(host.tool, "truncated-call");
        const outputPath = result.details.run.fullOutputPath;
        expect(result.content[0].text).toContain("[Output truncated:");
        expect(outputPath).toBeString();
        expect(await fs.promises.readFile(outputPath, "utf8")).toBe(output);
        const mode = (await fs.promises.stat(outputPath)).mode & 0o777;
        expect(mode).toBe(0o600);
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" });
        await expect(fs.promises.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("blocking settlement overlapping shutdown cannot create a late full-output spill", async () => {
        const host = fakePi();
        let finish!: () => void;
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                await new Promise<void>((resolve) => (finish = resolve));
                const details = createTerminalSubagentDetails(options.details, { status: "succeeded" });
                return { details, output: "x".repeat(60_000), stderr: "", exitCode: 0, signal: null };
            },
        });
        const execution = execute(host.tool, "shutdown-spill-race");
        await waitUntil(() => finish !== undefined);
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" });
        finish();
        const result = await execution;
        expect(result.details.run.fullOutputPath).toBeUndefined();
        expect(result.content[0].text).not.toContain("Full output saved to:");
    });

    test("throws failures and patches terminal details into the persisted tool result once", async () => {
        const host = fakePi();
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
                options.onSnapshot?.(details);
                details = createTerminalSubagentDetails(details, {
                    status: "failed",
                    error: "actionable child failure",
                });
                options.onSnapshot?.(details);
                return { details, output: "", stderr: "fixture stderr", exitCode: 3, signal: null };
            },
        });

        await expect(execute(host.tool, "failed-call")).rejects.toThrow("actionable child failure");
        const handler = host.handler("tool_result");
        const patch = await handler({ toolCallId: "failed-call" });
        expect(patch.details.run.status).toBe("failed");
        expect(patch.details.run.error).toBe("actionable child failure");
        expect(await handler({ toolCallId: "failed-call" })).toBeUndefined();
    });

    test("runs four children while later calls remain visibly queued", async () => {
        const host = fakePi();
        const semaphore = new AbortableSemaphore(4);
        let active = 0;
        let maxActive = 0;
        registerSubagentExtension(host.pi, {
            semaphore,
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                active++;
                maxActive = Math.max(maxActive, active);
                let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
                options.onSnapshot?.(details);
                await Bun.sleep(30);
                details = createTerminalSubagentDetails(details, { status: "succeeded", outputPreview: "ok" });
                options.onSnapshot?.(details);
                active--;
                return { details, output: "ok", stderr: "", exitCode: 0, signal: null };
            },
        });
        const statuses = Array.from({ length: 5 }, () => [] as string[]);
        const executions = statuses.map((items, index) =>
            execute(host.tool, `call-${index}`, {
                onUpdate: (update) => items.push(update.details.run.status),
            }),
        );

        await waitUntil(() => semaphore.active === 4 && semaphore.queued === 1);
        const queuedIndex = statuses.findIndex((items) => items.length === 1 && items[0] === "queued");
        expect(queuedIndex).toBeGreaterThanOrEqual(0);
        await Promise.all(executions);
        expect(maxActive).toBe(4);
        expect(statuses[queuedIndex]).toEqual(["queued", "starting", "running", "succeeded"]);
        expect(semaphore.active).toBe(0);
    });

    test("queued calls can be cancelled without spawning", async () => {
        const host = fakePi();
        const semaphore = new AbortableSemaphore(1);
        const occupy = await semaphore.acquire();
        let runnerCalled = false;
        registerSubagentExtension(host.pi, {
            semaphore,
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                runnerCalled = true;
                return successRun()(options);
            },
        });
        const controller = new AbortController();
        const statuses: string[] = [];
        const execution = execute(host.tool, "queued-cancel", {
            signal: controller.signal,
            onUpdate: (update) => statuses.push(update.details.run.status),
        });
        await waitUntil(() => semaphore.queued === 1);
        controller.abort();

        await expect(execution).rejects.toThrow("cancelled while queued");
        occupy();
        expect(runnerCalled).toBe(false);
        expect(statuses).toEqual(["queued", "cancelled"]);
        const patch = await host.handler("tool_result")({ toolCallId: "queued-cancel" });
        expect(patch.details.run.status).toBe("cancelled");
    });

    test("blocking and background jobs share the same process semaphore", async () => {
        const host = fakePi();
        const semaphore = new AbortableSemaphore(1);
        let releaseBackground: (() => void) | undefined;
        registerSubagentExtension(host.pi, {
            semaphore,
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
                options.onSnapshot?.(details);
                if (options.details.run.id !== "blocking-after-background") {
                    await new Promise<void>((resolve) => {
                        releaseBackground = resolve;
                    });
                }
                details = createTerminalSubagentDetails(details, { status: "succeeded", outputPreview: "done" });
                options.onSnapshot?.(details);
                return { details, output: "done", stderr: "", exitCode: 0, signal: null };
            },
        });

        const spawned = await host.tools
            .get("subagent_spawn")
            .execute("spawn-call", { prompt: "Background work", cwd: extensionCwd }, undefined, undefined, {
                cwd: extensionCwd,
            });
        await waitUntil(() => semaphore.active === 1);
        const blocking = execute(host.tool, "blocking-after-background");
        await waitUntil(() => semaphore.queued === 1);
        expect(spawned.content[0].text).toContain("Started background subagent");
        releaseBackground?.();
        await blocking;
        expect(semaphore.active).toBe(0);
    });

    test("background controls reject stale or malformed envelopes and unsubscribe on shutdown", async () => {
        const host = fakePi();
        const running = new Map<string, AbortSignal>();
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(8),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                running.set(options.details.run.id, options.signal!);
                await new Promise<void>((resolve) =>
                    options.signal!.addEventListener("abort", () => resolve(), { once: true }),
                );
                return {
                    details: createTerminalSubagentDetails(options.details, {
                        status: "cancelled",
                        error: "control cancellation",
                    }),
                    output: "",
                    stderr: "",
                    exitCode: null,
                    signal: "SIGTERM",
                };
            },
        });
        await host.handler("session_start")(
            {},
            {
                sessionManager: { getSessionId: () => "current-session" },
                isIdle: () => false,
            },
        );
        const ready = host.emitted.find(({ payload }) => payload.type === "ready")!.payload;
        const spawn = async (name: string) => {
            const result = await host.tools
                .get("subagent_spawn")
                .execute(`spawn-${name}`, { prompt: name, cwd: extensionCwd }, undefined, undefined, {
                    cwd: extensionCwd,
                });
            await waitUntil(() => running.has(result.details.id));
            return result.details.id as string;
        };
        const control = (jobId: string, overrides: Record<string, unknown> = {}) => ({
            schema: BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
            version: BACKGROUND_SUBAGENT_VERSION,
            sessionId: ready.sessionId,
            instanceId: ready.instanceId,
            type: "cancel",
            jobId,
            ...overrides,
        });

        const validId = await spawn("valid");
        host.events.emit(BACKGROUND_SUBAGENT_CONTROL_CHANNEL, control(validId));
        await waitUntil(() => running.get(validId)?.aborted === true);
        await waitUntil(() =>
            host.emitted.some(({ payload }) => payload.job?.id === validId && payload.job.run.status === "cancelled"),
        );
        expect((await host.tools.get("subagent_check").execute("check", { id: validId })).details.run.status).toBe(
            "cancelled",
        );

        const rejected = [
            { id: await spawn("stale session"), override: { sessionId: "stale-session" } },
            { id: await spawn("stale instance"), override: { instanceId: "stale-instance" } },
            { id: await spawn("malformed id"), override: { jobId: "" } },
            { id: await spawn("unknown version"), override: { version: 2 } },
        ];
        for (const { id, override } of rejected)
            host.events.emit(BACKGROUND_SUBAGENT_CONTROL_CHANNEL, control(id, override));
        const sentinelId = await spawn("bus drain sentinel");
        host.events.emit(BACKGROUND_SUBAGENT_CONTROL_CHANNEL, control(sentinelId));
        await waitUntil(() => running.get(sentinelId)?.aborted === true);
        expect(rejected.map(({ id }) => running.get(id)?.aborted)).toEqual([false, false, false, false]);
        expect(host.listenerCount(BACKGROUND_SUBAGENT_CONTROL_CHANNEL)).toBe(1);

        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" });
        expect(host.listenerCount(BACKGROUND_SUBAGENT_CONTROL_CHANNEL)).toBe(0);
        for (const { id } of rejected) expect(running.get(id)?.aborted).toBe(true);
    });

    test("delivers a background result after an aborted waiter goes away", async () => {
        const host = fakePi();
        let finish: (() => void) | undefined;
        registerSubagentExtension(host.pi, {
            semaphore: new AbortableSemaphore(1),
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                await new Promise<void>((resolve) => {
                    finish = resolve;
                });
                const details = createTerminalSubagentDetails(options.details, {
                    status: "succeeded",
                    outputPreview: "late result",
                });
                options.onSnapshot?.(details);
                return { details, output: "late result", stderr: "", exitCode: 0, signal: null };
            },
        });

        const spawned = await host.tools
            .get("subagent_spawn")
            .execute("spawn-late", { prompt: "Late work", cwd: extensionCwd }, undefined, undefined, {
                cwd: extensionCwd,
            });
        await waitUntil(() => finish !== undefined);
        const controller = new AbortController();
        const waiting = host.tools
            .get("subagent_wait")
            .execute("wait-late", { ids: [spawned.details.id] }, controller.signal);
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });

        finish?.();
        await waitUntil(() => host.sent.some(({ message }) => message.details?.id === spawned.details.id));
        expect(host.sent.find(({ message }) => message.details?.id === spawned.details.id)?.message.content).toContain(
            "late result",
        );
    });

    test("session shutdown aborts running work and leaves no saved failure state", async () => {
        const host = fakePi();
        const semaphore = new AbortableSemaphore(1);
        registerSubagentExtension(host.pi, {
            semaphore,
            invocation: (args) => ({ command: "fake-pi", args }),
            run: async (options) => {
                let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
                options.onSnapshot?.(details);
                await new Promise<void>((resolve) =>
                    options.signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                details = createTerminalSubagentDetails(details, {
                    status: "cancelled",
                    error: "shutdown cancellation",
                });
                options.onSnapshot?.(details);
                return { details, output: "", stderr: "", exitCode: null, signal: "SIGTERM" };
            },
        });
        const execution = execute(host.tool, "shutdown-call");
        await waitUntil(() => semaphore.active === 1);
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" });

        await expect(execution).rejects.toThrow("shutdown cancellation");
        expect(semaphore.active).toBe(0);
        expect(await host.handler("tool_result")({ toolCallId: "shutdown-call" })).toBeUndefined();
    });
});
