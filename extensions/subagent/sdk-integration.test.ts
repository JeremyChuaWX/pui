import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerSubagentExtension } from "./index.ts";
import { createTerminalSubagentDetails, isSubagentDetailsV1, updateSubagentDetails } from "./protocol.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function parentMessage(content: any[], stopReason: "toolUse" | "stop") {
    return {
        role: "assistant" as const,
        content,
        api: "fixture-api",
        provider: "fixture-parent",
        model: "fixture-parent-model",
        usage,
        stopReason,
        timestamp: Date.now(),
    };
}

test("installed resource loader can load the extension source and its local modules", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-loader-test-"));
    try {
        const loader = new DefaultResourceLoader({
            cwd: temp,
            agentDir: temp,
            settingsManager: SettingsManager.inMemory(),
            additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
        });
        await loader.reload();
        expect(loader.getExtensions().errors).toEqual([]);
        expect(loader.getExtensions().extensions).toHaveLength(1);
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("background delivery persists once on resume and wait consumption suppresses delivery", async () => {
    for (const consumeWithWait of [false, true]) {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-background-sdk-test-"));
        const sessionDir = path.join(temp, "sessions");
        const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const modelRuntime = await ModelRuntime.create({
            authPath: path.join(temp, "auth.json"),
            modelsPath: null,
            allowModelNetwork: false,
        });
        let turn = 0;
        let allowBackgroundSettlement!: () => void;
        const backgroundMaySettle = new Promise<void>((resolve) => {
            allowBackgroundSettlement = resolve;
        });
        let markBackgroundSettled!: () => void;
        const backgroundSettled = new Promise<void>((resolve) => {
            markBackgroundSettled = resolve;
        });
        const requestedTitle = "T".repeat(200);
        modelRuntime.registerProvider("fixture-background", {
            api: "fixture-api",
            baseUrl: "http://fixture.invalid",
            apiKey: "fixture-key",
            models: [
                {
                    id: "fixture-background-model",
                    name: "Fixture Background Model",
                    api: "fixture-api",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 64_000,
                    maxTokens: 1_000,
                },
            ],
            streamSimple: (_model, context) => {
                const stream = createAssistantMessageEventStream();
                const currentTurn = turn++;
                void (async () => {
                    let content: any[];
                    let stopReason: "toolUse" | "stop";
                    if (currentTurn === 0) {
                        content = [
                            {
                                type: "toolCall",
                                id: "spawn-background",
                                name: "subagent_spawn",
                                arguments: { prompt: "Produce the large fixture", cwd: temp, name: requestedTitle },
                            },
                        ];
                        stopReason = "toolUse";
                    } else if (consumeWithWait && currentTurn === 1) {
                        const spawnResult = context.messages.find(
                            (message) => message.role === "toolResult" && message.toolCallId === "spawn-background",
                        );
                        const text =
                            spawnResult?.role === "toolResult" && spawnResult.content[0]?.type === "text"
                                ? spawnResult.content[0].text
                                : "";
                        const id = text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
                        if (!id) throw new Error("Missing background id in spawn result");
                        content = [
                            {
                                type: "toolCall",
                                id: "wait-background",
                                name: "subagent_wait",
                                arguments: { ids: [id] },
                            },
                        ];
                        stopReason = "toolUse";
                    } else {
                        content = [{ type: "text", text: "Parent settled." }];
                        stopReason = "stop";
                    }
                    const message = parentMessage(content, stopReason);
                    stream.push({ type: "start", partial: message });
                    if (currentTurn > 0) {
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        allowBackgroundSettlement();
                        await backgroundSettled;
                    }
                    stream.push({ type: "done", reason: stopReason, message });
                })();
                return stream;
            },
        });
        const model = modelRuntime.getModel("fixture-background", "fixture-background-model");
        if (!model) throw new Error("Fixture model was not registered");
        const fullOutput = `${"background output\n".repeat(1_000)}tail marker`;
        const loader = new DefaultResourceLoader({
            cwd: temp,
            agentDir: temp,
            settingsManager: settings,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
                {
                    name: "subagent-background-sdk-fixture",
                    factory: (pi) => {
                        pi.events?.on("pui.subagent.background", (event: any) => {
                            if (event.job?.run.status === "succeeded" && event.job.run.fullOutputPath)
                                markBackgroundSettled();
                        });
                        registerSubagentExtension(pi, {
                            semaphore: new AbortableSemaphore(1),
                            invocation: (args) => ({ command: "fake-pi", args }),
                            run: async (options) => {
                                await backgroundMaySettle;
                                const details = createTerminalSubagentDetails(options.details, {
                                    status: "succeeded",
                                    outputPreview: "background output",
                                });
                                return { details, output: fullOutput, stderr: "", exitCode: 0, signal: null };
                            },
                        });
                    },
                },
            ],
        });
        await loader.reload();
        const manager = SessionManager.create(temp, sessionDir);
        const { session } = await createAgentSession({
            cwd: temp,
            agentDir: temp,
            model,
            modelRuntime,
            resourceLoader: loader,
            settingsManager: settings,
            sessionManager: manager,
            tools: ["subagent_spawn", "subagent_wait"],
        });
        let outputDirectory: string | undefined;
        try {
            await session.prompt("Start the background fixture.");
            await session.agent.waitForIdle();
            const sessionFile = manager.getSessionFile();
            if (!sessionFile) throw new Error("Expected a persisted session file");
            const reopened = SessionManager.open(sessionFile, sessionDir);
            const branch = reopened.getBranch();
            const results = branch.filter(
                (entry) => entry.type === "custom_message" && entry.customType === "subagent-result",
            );
            expect(results).toHaveLength(consumeWithWait ? 0 : 1);
            if (consumeWithWait) {
                const waitEntry = branch.find(
                    (entry) =>
                        entry.type === "message" &&
                        entry.message.role === "toolResult" &&
                        entry.message.toolCallId === "wait-background",
                );
                const outputPath =
                    waitEntry?.type === "message" && waitEntry.message.role === "toolResult"
                        ? (waitEntry.message.details as any)?.results?.[0]?.fullOutputPath
                        : undefined;
                expect(outputPath).toBeString();
                if (typeof outputPath === "string") {
                    outputDirectory = path.dirname(outputPath);
                    expect(await fs.promises.readFile(outputPath, "utf8")).toBe(fullOutput);
                }
            } else {
                const result = results[0];
                if (result?.type !== "custom_message") throw new Error("Missing resumed background result");
                expect(result.display).toBe(true);
                expect(result.details).toEqual({
                    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
                    title: "T".repeat(160),
                    status: "succeeded",
                });
                expect(result.content).toContain("Output truncated for delivery");
                const outputPath = String(result.content).match(/Full output: ([^\]\n]+)/)?.[1];
                expect(outputPath).toBeTruthy();
                if (outputPath) {
                    outputDirectory = path.dirname(outputPath);
                    expect(await fs.promises.readFile(outputPath, "utf8")).toBe(fullOutput);
                }
            }
        } finally {
            session.dispose();
            await settings.flush();
            if (outputDirectory) await fs.promises.rm(outputDirectory, { recursive: true, force: true });
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    }
});

test("installed AgentSession transports parallel updates and persists success and failure details", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-sdk-test-"));
    const sessionDir = path.join(temp, "sessions");
    const settings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const modelRuntime = await ModelRuntime.create({
        authPath: path.join(temp, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
    });
    let parentTurn = 0;
    modelRuntime.registerProvider("fixture-parent", {
        api: "fixture-api",
        baseUrl: "http://fixture.invalid",
        apiKey: "fixture-key",
        models: [
            {
                id: "fixture-parent-model",
                name: "Fixture Parent Model",
                api: "fixture-api",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 16_000,
                maxTokens: 1_000,
            },
        ],
        streamSimple: () => {
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
                const message =
                    parentTurn++ === 0
                        ? parentMessage(
                              [
                                  {
                                      type: "toolCall",
                                      id: "outer-sdk-success",
                                      name: "subagent",
                                      arguments: {
                                          prompt: "Implement the successful SDK fixture",
                                          cwd: temp,
                                      },
                                  },
                                  {
                                      type: "toolCall",
                                      id: "outer-sdk-failure",
                                      name: "subagent",
                                      arguments: {
                                          agent: "explore",
                                          prompt: "Inspect the failing SDK fixture",
                                          cwd: temp,
                                      },
                                  },
                              ],
                              "toolUse",
                          )
                        : parentMessage([{ type: "text", text: "Parent received the delegated result." }], "stop");
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: message.stopReason, message });
            });
            return stream;
        },
    });
    const model = modelRuntime.getModel("fixture-parent", "fixture-parent-model");
    if (!model) throw new Error("Fixture model was not registered");

    const loader = new DefaultResourceLoader({
        cwd: temp,
        agentDir: temp,
        settingsManager: settings,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "Use the subagent tool once.",
        extensionFactories: [
            {
                name: "subagent-sdk-fixture",
                factory: (pi) =>
                    registerSubagentExtension(pi, {
                        semaphore: new AbortableSemaphore(4),
                        invocation: (args) => ({ command: "fake-pi", args }),
                        run: async (options) => {
                            const shouldFail = options.details.run.id === "outer-sdk-failure";
                            let details = updateSubagentDetails(options.details, {
                                status: "running",
                                phase: "thinking",
                                startedAt: options.details.run.startedAt ?? Date.now(),
                            });
                            options.onSnapshot?.(details);
                            await Bun.sleep(shouldFail ? 5 : 20);
                            details = createTerminalSubagentDetails(
                                details,
                                shouldFail
                                    ? { status: "failed", error: "SDK delegated failure" }
                                    : { status: "succeeded", outputPreview: "SDK delegated output" },
                            );
                            options.onSnapshot?.(details);
                            return {
                                details,
                                output: shouldFail ? "" : "SDK delegated output",
                                stderr: shouldFail ? "SDK fixture stderr" : "",
                                exitCode: shouldFail ? 9 : 0,
                                signal: null,
                            };
                        },
                    }),
            },
        ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);

    const manager = SessionManager.create(temp, sessionDir);
    const { session } = await createAgentSession({
        cwd: temp,
        agentDir: temp,
        model,
        modelRuntime,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: manager,
        tools: ["subagent"],
    });
    const statuses = new Map<string, string[]>();
    session.subscribe((event) => {
        if (event.type !== "tool_execution_update") return;
        const details = event.partialResult?.details;
        if (!isSubagentDetailsV1(details)) return;
        const items = statuses.get(details.run.id) ?? [];
        items.push(details.run.status);
        statuses.set(details.run.id, items);
    });

    try {
        await session.prompt("Delegate these tasks.");
        expect(statuses.get("outer-sdk-success")).toEqual(["queued", "starting", "running", "succeeded"]);
        expect(statuses.get("outer-sdk-failure")).toEqual(["queued", "starting", "running", "failed"]);

        const persistedResults = manager
            .getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message)
            .filter((message) => message.role === "toolResult");
        const persistedSuccess = persistedResults.find((message) => message.toolCallId === "outer-sdk-success");
        const persistedFailure = persistedResults.find((message) => message.toolCallId === "outer-sdk-failure");
        if (persistedSuccess?.role !== "toolResult" || persistedFailure?.role !== "toolResult") {
            throw new Error("Missing persisted subagent tool results");
        }
        expect(persistedSuccess.isError).toBe(false);
        expect(isSubagentDetailsV1(persistedSuccess.details)).toBe(true);
        expect((persistedSuccess.details as any).run.status).toBe("succeeded");
        expect((persistedSuccess.details as any).run.agent).toBe("generic");
        expect(persistedSuccess.content[0]).toEqual({ type: "text", text: "SDK delegated output" });
        expect(persistedFailure.isError).toBe(true);
        expect(isSubagentDetailsV1(persistedFailure.details)).toBe(true);
        expect((persistedFailure.details as any).run.status).toBe("failed");
        expect((persistedFailure.details as any).run.agent).toBe("explore");
        expect((persistedFailure.details as any).run.error).toBe("SDK delegated failure");

        const sessionFile = manager.getSessionFile();
        if (!sessionFile) throw new Error("Expected a persisted session file");
        const reopened = SessionManager.open(sessionFile, sessionDir);
        const resumedResults = reopened
            .getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message)
            .filter((message) => message.role === "toolResult");
        for (const [id, status, agent] of [
            ["outer-sdk-success", "succeeded", "generic"],
            ["outer-sdk-failure", "failed", "explore"],
        ] as const) {
            const resumed = resumedResults.find((message) => message.toolCallId === id);
            expect(resumed?.role === "toolResult" && isSubagentDetailsV1(resumed.details)).toBe(true);
            if (resumed?.role === "toolResult" && isSubagentDetailsV1(resumed.details)) {
                expect(resumed.details.run.status).toBe(status);
                expect(resumed.details.run.agent).toBe(agent);
                expect(resumed.details.run.id).toBe(id);
            }
        }
    } finally {
        session.dispose();
        await settings.flush();
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
