import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type AgentSessionRuntime,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createEventBus,
    type EventBusController,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerSubagentExtension } from "../extensions/subagent/index.js";
import { AbortableSemaphore } from "../extensions/subagent/semaphore.js";
import { PuiController } from "./controller.js";

const fixtureChild = fileURLToPath(new URL("../extensions/subagent/fixtures/fake-child.mjs", import.meta.url));

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await Bun.sleep(5);
    }
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function refresh(controller: PuiController): void {
    (controller as unknown as { refresh(): void }).refresh();
}

async function createHarness(temp: string) {
    const cwd = path.join(temp, "cwd");
    const agentDir = path.join(temp, "agent");
    await Promise.all([fs.promises.mkdir(cwd), fs.promises.mkdir(agentDir)]);
    const bus = createEventBus();
    const lifecycleEvents: any[] = [];
    bus.on("pui.subagent.background", (event) => lifecycleEvents.push(event));
    const pidPaths: string[] = [];
    const factory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }: any) => {
        const services = await createAgentSessionServices({
            cwd: runtimeCwd,
            agentDir,
            resourceLoaderOptions: {
                eventBus: bus,
                extensionFactories: [
                    {
                        name: "lifecycle-subagent",
                        factory: (pi: any) =>
                            registerSubagentExtension(pi, {
                                semaphore: new AbortableSemaphore(1),
                                invocation: () => {
                                    const pidPath = path.join(temp, `descendant-${randomUUID()}.pid`);
                                    pidPaths.push(pidPath);
                                    return {
                                        command: process.execPath,
                                        args: [fixtureChild, "descendant-hang", pidPath],
                                    };
                                },
                            }),
                    },
                ],
            },
        });
        return {
            ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
            services,
            diagnostics: services.diagnostics,
        };
    };
    const runtime = await createAgentSessionRuntime(factory, {
        cwd,
        agentDir,
        sessionManager: SessionManager.create(cwd, path.join(temp, "runtime-sessions")),
    });
    const Controller = PuiController as unknown as new (
        runtime: AgentSessionRuntime,
        eventBus: EventBusController,
    ) => PuiController;
    const controller = new Controller(runtime, bus);
    runtime.setRebindSession(async (session) =>
        (controller as unknown as { bindSession(session: typeof runtime.session): Promise<void> }).bindSession(session),
    );
    await (controller as unknown as { bindSession(session: typeof runtime.session): Promise<void> }).bindSession(
        runtime.session,
    );
    return { bus, controller, cwd, lifecycleEvents, pidPaths, runtime };
}

function backgroundMessages(session: AgentSessionRuntime["session"]): unknown[] {
    return session.messages.filter(
        (message: any) => message.role === "custom" && message.customType === "subagent-result",
    );
}

describe("controller background runtime lifecycle", () => {
    test.skipIf(process.platform === "win32")(
        "replaces active child instances across every runtime transition and final disposal",
        async () => {
            const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-background-lifecycle-"));
            const harness = await createHarness(temp);
            const { bus, controller, lifecycleEvents, runtime } = harness;
            const exercise = async (transition: () => Promise<unknown>) => {
                const oldSession = runtime.session;
                const ready = lifecycleEvents.filter((event) => event.type === "ready").at(-1);
                expect(ready).toBeDefined();
                const spawn = oldSession.agent.state.tools.find((tool) => tool.name === "subagent_spawn");
                if (!spawn) throw new Error("Missing background spawn tool");
                const result = await spawn.execute(
                    `spawn-${randomUUID()}`,
                    { prompt: "active child", cwd: harness.cwd },
                    new AbortController().signal,
                    undefined,
                );
                const jobId = (result.details as any).id as string;
                const pidPath = harness.pidPaths.at(-1);
                if (!pidPath) throw new Error("Missing recorded descendant pid path");
                await waitUntil(() => fs.existsSync(pidPath), "descendant pid file");
                const [childPid, descendantPid] = (await fs.promises.readFile(pidPath, "utf8")).split(":").map(Number);
                expect(isAlive(childPid!)).toBe(true);
                expect(isAlive(descendantPid!)).toBe(true);
                refresh(controller);
                expect(controller.snapshot().backgroundSubagents.map((job) => job.id)).toContain(jobId);

                await transition();
                await waitUntil(() => !isAlive(childPid!), "old child termination");
                await waitUntil(() => !isAlive(descendantPid!), "old descendant termination");
                refresh(controller);
                expect(controller.snapshot().backgroundSubagents).toEqual([]);
                expect(backgroundMessages(oldSession)).toEqual([]);

                bus.emit("pui.subagent.background", {
                    ...ready,
                    type: "upsert",
                    job: result.details,
                });
                refresh(controller);
                expect(controller.snapshot().backgroundSubagents).toEqual([]);

                const newReady = lifecycleEvents.filter((event) => event.type === "ready").at(-1);
                expect(newReady?.instanceId).not.toBe(ready.instanceId);
                expect(runtime.session.agent.state.tools.some((tool) => tool.name === "subagent_spawn")).toBe(true);
                const replacementEnvelope = {
                    ...newReady,
                    type: "upsert",
                    job: result.details,
                };
                bus.emit("pui.subagent.background", replacementEnvelope);
                refresh(controller);
                expect(controller.snapshot().backgroundSubagents.map((job) => job.id)).toEqual([jobId]);
                bus.emit("pui.subagent.background", { ...replacementEnvelope, type: "remove" });
                refresh(controller);
                expect(controller.snapshot().backgroundSubagents).toEqual([]);
            };

            try {
                await exercise(() => runtime.session.reload());
                await exercise(() => runtime.newSession());

                const resumed = SessionManager.create(harness.cwd, path.join(temp, "sessions"));
                resumed.appendMessage({ role: "user", content: "resume fixture", timestamp: Date.now() });
                resumed.appendMessage({
                    role: "assistant",
                    content: [{ type: "text", text: "saved" }],
                    api: "fixture",
                    provider: "fixture",
                    model: "fixture",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                    timestamp: Date.now(),
                });
                const resumedPath = resumed.getSessionFile();
                if (!resumedPath) throw new Error("Expected persisted resume fixture");
                await exercise(() => runtime.switchSession(resumedPath));

                const forkEntry = runtime.session.sessionManager.appendMessage({
                    role: "user",
                    content: "fork fixture",
                    timestamp: Date.now(),
                });
                await exercise(() => runtime.fork(forkEntry));
                const cloneEntry = runtime.session.sessionManager.appendMessage({
                    role: "user",
                    content: "clone fixture",
                    timestamp: Date.now(),
                });
                await exercise(() => runtime.fork(cloneEntry, { position: "at" }));

                const oldSession = runtime.session;
                const spawn = oldSession.agent.state.tools.find((tool) => tool.name === "subagent_spawn");
                if (!spawn) throw new Error("Missing final background spawn tool");
                await spawn.execute(
                    "final-spawn",
                    { prompt: "active at disposal", cwd: harness.cwd },
                    new AbortController().signal,
                    undefined,
                );
                const pidPath = harness.pidPaths.at(-1);
                if (!pidPath) throw new Error("Missing recorded final descendant pid path");
                await waitUntil(() => fs.existsSync(pidPath), "final descendant pid file");
                const [childPid, descendantPid] = (await fs.promises.readFile(pidPath, "utf8")).split(":").map(Number);
                expect(isAlive(childPid!)).toBe(true);
                expect(isAlive(descendantPid!)).toBe(true);
                await controller.dispose();
                await waitUntil(() => !isAlive(childPid!), "final child termination");
                await waitUntil(() => !isAlive(descendantPid!), "final descendant termination");
                expect(controller.snapshot().backgroundSubagents).toEqual([]);
                expect(backgroundMessages(oldSession)).toEqual([]);
            } finally {
                await controller.dispose();
                await fs.promises.rm(temp, { recursive: true, force: true });
            }
        },
        40_000,
    );
});
