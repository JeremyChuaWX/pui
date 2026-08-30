import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDefaultSubagentDependencies, registerSubagentExtension } from "#modules/subagents/interfaces/pi.js";
import { type Runner, type RunResult, SUBAGENT_JOBS_CHANNEL } from "#modules/subagents/protocol.js";
import { createExtensionApiHarness } from "#test-support/extension-api.js";
import { createFakeClock, settleEventLoop } from "#test-support/fake-clock.js";

const sessionIds: string[] = [];
afterEach(() => {
    for (const id of sessionIds.splice(0)) {
        fs.rmSync(path.join(os.tmpdir(), "pi-subagents", id), { recursive: true, force: true });
    }
});

function controlledRunner() {
    const started: Array<{
        signal: AbortSignal;
        resolve: (result: RunResult) => void;
        reject: (error: unknown) => void;
    }> = [];
    const run: Runner = (_config, signal) =>
        new Promise((resolve, reject) => {
            started.push({ signal, resolve, reject });
        });
    return { run, started };
}

async function setup() {
    const host = createExtensionApiHarness();
    const runner = controlledRunner();
    const fake = createFakeClock();
    registerSubagentExtension(host.api, {
        createRunner: () => runner.run,
        clock: fake.clock,
        maxActive: 1,
        maxQueued: 2,
    });
    const sessionId = `pui-subagent-test-${process.pid}-${Date.now()}-${sessionIds.length}`;
    sessionIds.push(sessionId);
    const context = {
        cwd: "/work",
        sessionManager: { getSessionId: () => sessionId },
        modelRegistry: { find: () => undefined },
    };
    await host.handler("session_start")({ type: "session_start", reason: "startup" }, context);
    return { host, runner, fake, sessionId, context };
}

describe("subagent Extension", () => {
    test("normalizes configured concurrency to an integer from one through 64", () => {
        expect(createDefaultSubagentDependencies({ environment: {} }).maxActive).toBe(4);
        expect(createDefaultSubagentDependencies({ environment: { PI_SUBAGENT_MAX_ACTIVE: "" } }).maxActive).toBe(4);
        expect(
            createDefaultSubagentDependencies({ environment: { PI_SUBAGENT_MAX_ACTIVE: "invalid" } }).maxActive,
        ).toBe(4);
        expect(createDefaultSubagentDependencies({ environment: { PI_SUBAGENT_MAX_ACTIVE: "0" } }).maxActive).toBe(1);
        expect(createDefaultSubagentDependencies({ environment: { PI_SUBAGENT_MAX_ACTIVE: "2.9" } }).maxActive).toBe(2);
        expect(createDefaultSubagentDependencies({ environment: { PI_SUBAGENT_MAX_ACTIVE: "99" } }).maxActive).toBe(64);
    });

    test("registers the local Pi tool surface and lifecycle", async () => {
        const { host } = await setup();
        expect([...host.tools.keys()]).toEqual(["explorer", "worker", "subagent_cancel", "subagent_list"]);
        expect(host.handlers.has("session_start")).toBe(true);
        expect(host.handlers.has("session_shutdown")).toBe(true);
        expect(host.messageRenderers.has("subagent-result")).toBe(true);

        for (const name of ["explorer", "worker"]) {
            const tool = host.tool(name);
            expect(tool.parameters.required).toEqual(["task"]);
            expect(Object.keys(tool.parameters.properties)).toEqual(["task", "cwd"]);
            expect(tool.description).toContain("result is injected");
        }
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
    });

    test("returns immediately, publishes active Jobs, and steers a completed result", async () => {
        const { host, runner, sessionId, context } = await setup();
        const spawned = await host
            .tool("explorer")
            .execute("spawn", { task: "inspect it" }, undefined, undefined, context);
        expect(spawned.details).toMatchObject({ id: "explorer_1", state: "running", cwd: "/work" });
        expect(spawned.content[0].text).toContain("do not wait or poll");
        const active = host.emitted.filter(({ channel }) => channel === SUBAGENT_JOBS_CHANNEL).at(-1)?.payload;
        expect(active).toMatchObject({
            sessionId,
            jobs: [expect.objectContaining({ id: "explorer_1", state: "running" })],
        });

        const listed = await host.tool("subagent_list").execute("list", {});
        expect(listed.terminate).toBe(true);
        expect(listed.content[0].text).toContain("explorer_1");

        runner.started[0]!.resolve({
            text: "## Finding\n\nFound it.",
            partial: false,
            usage: { input: 3_000, output: 2_000, totalTokens: 5_000, cost: 0 },
        });
        await settleEventLoop();

        expect(host.emitted.filter(({ channel }) => channel === SUBAGENT_JOBS_CHANNEL).at(-1)?.payload).toEqual({
            sessionId,
            jobs: [],
        });
        expect(host.messages).toHaveLength(1);
        const [message, options] = host.messages[0]!;
        expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
        expect(message).toMatchObject({
            customType: "subagent-result",
            display: true,
            details: { id: "explorer_1", status: "completed", profile: "explorer" },
        });
        const location = (message.details as { location: string }).location;
        expect(await fs.promises.readFile(location, "utf8")).toBe("## Finding\n\nFound it.");
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
    });

    test("cancels through the management tool and emits no result message", async () => {
        const { host, runner, context } = await setup();
        await host.tool("worker").execute("spawn", { task: "implement it" }, undefined, undefined, context);
        const cancelling = host.tool("subagent_cancel").execute("cancel", { ids: ["worker_1"] });
        expect(runner.started[0]!.signal.aborted).toBe(true);
        runner.started[0]!.reject(new Error("aborted"));
        expect((await cancelling).content[0].text).toBe("[worker_1] cancelled");
        expect(host.messages).toEqual([]);
        expect((await host.tool("subagent_list").execute("list", {})).content[0].text).toBe("No active subagent Jobs.");
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
    });

    test("ignores late snapshots and results from a replaced Manager", async () => {
        const { host, runner, fake, sessionId, context } = await setup();
        await host.tool("explorer").execute("old", { task: "old work" }, undefined, undefined, context);
        await fake.advance(10 * 60_000);
        expect(runner.started[0]!.signal.aborted).toBe(true);

        const reload = host.handler("session_start")({ type: "session_start", reason: "reload" }, context);
        await fake.advance(5_000);
        await reload;
        await host.tool("explorer").execute("new", { task: "new work" }, undefined, undefined, context);
        const emittedBeforeSettlement = host.emitted.length;

        runner.started[0]!.resolve({
            text: "stale output",
            partial: false,
            usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
        });
        await settleEventLoop();

        expect(host.messages).toEqual([]);
        expect(host.emitted).toHaveLength(emittedBeforeSettlement);
        expect(host.emitted.at(-1)).toMatchObject({
            channel: SUBAGENT_JOBS_CHANNEL,
            payload: {
                sessionId,
                jobs: [expect.objectContaining({ id: "explorer_1", task: "new work", state: "running" })],
            },
        });

        const cancelling = host.tool("subagent_cancel").execute("cancel", { ids: ["explorer_1"] });
        runner.started[1]!.reject(new Error("aborted"));
        await cancelling;
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
    });

    test("resolves relative cwd and keeps Profile config inside the runner", async () => {
        const host = createExtensionApiHarness();
        const configs: unknown[] = [];
        const run: Runner = async (config) => {
            configs.push(config);
            return { text: "done", partial: false, usage: { input: 0, output: 0, totalTokens: 0, cost: 0 } };
        };
        registerSubagentExtension(host.api, { createRunner: () => run });
        const context = {
            cwd: process.cwd(),
            sessionManager: { getSessionId: () => "profile-config" },
            modelRegistry: { find: () => undefined },
        };
        await host.handler("session_start")({ type: "session_start", reason: "startup" }, context);
        await host.tool("worker").execute("spawn", { task: "work", cwd: "src" }, undefined, undefined, context);
        await settleEventLoop();
        expect(configs[0]).toMatchObject({
            profile: "worker",
            task: "work",
            cwd: path.join(process.cwd(), "src"),
            tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
            model: "openrouter/z-ai/glm-5.3-flash",
            thinkingLevel: "high",
            promptMode: "append",
        });
        await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
        fs.rmSync(path.join(os.tmpdir(), "pi-subagents", "profile-config"), { recursive: true, force: true });
    });
});
