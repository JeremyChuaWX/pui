import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JobConfig } from "#modules/subagents/protocol.js";
import { createRunner } from "#modules/subagents/subagent.js";

const config: JobConfig = {
    profile: "explorer",
    task: "inspect",
    cwd: "/tmp",
    tools: ["read", "grep"],
    model: "fixture/model",
    thinkingLevel: "low",
    systemPrompt: "be concise",
    promptMode: "replace",
    inactivityMs: 10_000,
    hardMs: 60_000,
};

function assistant(text: string): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "fixture-api",
        provider: "fixture",
        model: "model",
        usage: {
            input: 2,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
    };
}

describe("in-process subagent runner", () => {
    test("prompts an isolated AgentSession, reports activity, collects output, and disposes", async () => {
        let listener: ((event: { type: string }) => void) | undefined;
        let disposed = false;
        let promptOptions: unknown;
        let sessionOptions: Record<string, unknown> | undefined;
        const messages: AgentMessage[] = [];
        const createSession = async (options: Record<string, unknown>) => {
            sessionOptions = options;
            return {
                session: {
                    state: { messages },
                    subscribe(next: (event: { type: string }) => void) {
                        listener = next;
                        return () => {
                            listener = undefined;
                        };
                    },
                    async prompt(_task: string, options: unknown) {
                        promptOptions = options;
                        listener?.({ type: "tool_execution_start" });
                        messages.push(assistant("found it"));
                        listener?.({ type: "message_end" });
                    },
                    async abort() {},
                    dispose() {
                        disposed = true;
                    },
                },
            };
        };
        const model = { provider: "fixture", id: "model" };
        let activity = 0;
        const runner = createRunner({
            resolveModel: () => model as never,
            createSession: createSession as never,
        });
        const result = await runner(config, new AbortController().signal, () => activity++);

        expect(result).toEqual({
            text: "found it",
            partial: false,
            usage: { input: 2, output: 3, totalTokens: 5, cost: 0 },
        });
        expect(activity).toBe(2);
        expect(disposed).toBe(true);
        expect(promptOptions).toEqual({ expandPromptTemplates: false, source: "extension" });
        expect(sessionOptions).toMatchObject({
            cwd: "/tmp",
            model,
            thinkingLevel: "low",
            tools: ["read", "grep"],
        });
        const resourceLoader = sessionOptions?.resourceLoader as {
            getSystemPrompt(): string | undefined;
            getAppendSystemPrompt(): string[];
        };
        expect(resourceLoader.getSystemPrompt()).toBe("be concise");
        expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
    });

    test("forwards cancellation to the child AgentSession", async () => {
        let abortChild = 0;
        let releasePrompt!: () => void;
        const createSession = async () => ({
            session: {
                state: { messages: [] },
                subscribe: () => () => {},
                prompt: () => new Promise<void>((resolve) => (releasePrompt = resolve)),
                async abort() {
                    abortChild++;
                    releasePrompt();
                },
                dispose() {},
            },
        });
        const runner = createRunner({
            resolveModel: () => ({ provider: "fixture", id: "model" }) as never,
            createSession: createSession as never,
        });
        const controller = new AbortController();
        const pending = runner(config, controller.signal, () => {});
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort();
        await pending;
        expect(abortChild).toBe(1);
    });

    test("rejects an unknown model or a signal aborted before session creation", async () => {
        let created = 0;
        const createSession = async () => {
            created++;
            throw new Error("should not create");
        };
        const unknownRunner = createRunner({ resolveModel: () => undefined, createSession: createSession as never });
        await expect(unknownRunner(config, new AbortController().signal, () => {})).rejects.toThrow(
            "Unknown model: fixture/model",
        );

        const cancelledRunner = createRunner({
            resolveModel: () => ({ provider: "fixture", id: "model" }) as never,
            createSession: createSession as never,
        });
        const controller = new AbortController();
        controller.abort();
        await expect(cancelledRunner(config, controller.signal, () => {})).rejects.toThrow("Cancelled before start");
        expect(created).toBe(0);
    });

    test("disposes a session when cancellation arrives while it is being built", async () => {
        let finishCreate!: (value: unknown) => void;
        let disposed = false;
        const createSession = () =>
            new Promise((resolve) => {
                finishCreate = resolve;
            });
        const runner = createRunner({
            resolveModel: () => ({ provider: "fixture", id: "model" }) as never,
            createSession: createSession as never,
        });
        const controller = new AbortController();
        const pending = runner(config, controller.signal, () => {});
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort();
        finishCreate({
            session: {
                dispose() {
                    disposed = true;
                },
            },
        });

        await expect(pending).rejects.toThrow("Cancelled before start");
        expect(disposed).toBe(true);
    });

    test("uses append prompt mode and cleans up when prompting fails", async () => {
        let disposed = false;
        let unsubscribed = false;
        let abortChild = 0;
        let resourceLoader: { getSystemPrompt(): string | undefined; getAppendSystemPrompt(): string[] } | undefined;
        const createSession = async (options: Record<string, unknown>) => {
            resourceLoader = options.resourceLoader as typeof resourceLoader;
            return {
                session: {
                    state: { messages: [] },
                    subscribe: () => () => {
                        unsubscribed = true;
                    },
                    async prompt() {
                        throw new Error("prompt failed");
                    },
                    async abort() {
                        abortChild++;
                    },
                    dispose() {
                        disposed = true;
                    },
                },
            };
        };
        const runner = createRunner({
            resolveModel: () => ({ provider: "fixture", id: "model" }) as never,
            createSession: createSession as never,
        });
        const controller = new AbortController();
        await expect(runner({ ...config, promptMode: "append" }, controller.signal, () => {})).rejects.toThrow(
            "prompt failed",
        );
        controller.abort();

        expect(resourceLoader?.getSystemPrompt()).toBeUndefined();
        expect(resourceLoader?.getAppendSystemPrompt()).toEqual(["be concise"]);
        expect(unsubscribed).toBe(true);
        expect(disposed).toBe(true);
        expect(abortChild).toBe(0);
    });
});
