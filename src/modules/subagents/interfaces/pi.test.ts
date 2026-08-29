import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createExtensionApiHarness } from "#test-support/extension-api.ts";
import { createFakeClock, settleEventLoop } from "#test-support/fake-clock.ts";
import { waitFor } from "#test-support/wait.ts";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
    BACKGROUND_SUBAGENT_SCHEMA,
    BACKGROUND_SUBAGENT_VERSION,
    type BackgroundSubagentEventV1,
    parseBackgroundSubagentEvent,
} from "../background-protocol.ts";
import type { SpawnChildAgent } from "../child-agent.ts";
import { createTerminalSubagentJob, updateSubagentJob } from "../job-state.ts";
import { AbortableSemaphore } from "../semaphore.ts";
import { registerSubagentExtension } from "./pi.ts";

const extensionCwd = path.dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;

function successRun(output = "delegated answer") {
    return async (options: any) => {
        const now = options.clock.now();
        let details = updateSubagentJob(
            options.job,
            { status: "running", phase: "thinking", startedAt: options.job.startedAt ?? now },
            now,
        );
        options.onSnapshot?.(details);
        details = createTerminalSubagentJob(details, { status: "succeeded", outputPreview: output }, now);
        options.onSnapshot?.(details);
        return { job: details, output, stderr: "", exitCode: 0, signal: null };
    };
}

/** An extension host whose fake child spawner records every runner invocation. */
function spawnHost(environment: NodeJS.ProcessEnv = {}, output = "delegated answer") {
    const host = createExtensionApiHarness();
    const runs: any[] = [];
    registerSubagentExtension(host.api, {
        semaphore: new AbortableSemaphore(4),
        environment,
        invocation: (args) => ({ command: "fake-pi", args }),
        run: async (options) => {
            runs.push(options);
            return successRun(output)(options);
        },
    });
    return {
        host,
        runs,
        /** Spawn under a Profile, then wait for the Job so the recorded runner options are complete. */
        async spawnAndWait(profile: "explorer" | "worker", params: Record<string, unknown> = {}) {
            const spawned = await host
                .tool(profile)
                .execute(
                    `${profile}-call`,
                    { prompt: `Use ${profile}`, cwd: extensionCwd, ...params },
                    undefined,
                    undefined,
                    {
                        cwd: extensionCwd,
                    },
                );
            const waited = await host.tool("subagent_wait").execute("wait", { ids: [spawned.details.id] });
            return { spawned, waited, run: runs.at(-1) };
        },
    };
}

function argumentAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
}

describe("subagent extension integration", () => {
    test("registers the two Profile spawn tools, the Job tools, and the lifecycle handlers", () => {
        const { host } = spawnHost();
        expect([...host.tools.keys()]).toEqual([
            "explorer",
            "worker",
            "subagent_wait",
            "subagent_check",
            "subagent_cancel",
        ]);
        expect(host.handlers.has("session_start")).toBe(true);
        expect(host.handlers.has("session_shutdown")).toBe(true);
        expect(host.handlers.has("agent_start")).toBe(false);
        expect(host.handlers.has("agent_settled")).toBe(false);
        expect(host.handlers.has("tool_result")).toBe(false);
    });

    test("explorer returns a Job id immediately and runs a read-only child with its own system prompt", async () => {
        const fixture = spawnHost();
        const { spawned, waited, run } = await fixture.spawnAndWait("explorer", { prompt: "Inspect the target" });

        expect(spawned.details.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(spawned.details.state.status).toBe("queued");
        expect(spawned.details.state.agent).toBe("explorer");
        expect(spawned.details.state.model).toBe("openrouter/z-ai/glm-5.3-flash:low");
        expect(spawned.content[0].text).toContain(spawned.details.id);
        expect(waited.details.results[0].status).toBe("succeeded");

        expect(run.command).toBe("fake-pi");
        expect(run.cwd).toBe(extensionCwd);
        expect(argumentAfter(run.args, "--mode")).toBe("json");
        for (const flag of [
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
        ]) {
            expect(run.args).toContain(flag);
        }
        expect(argumentAfter(run.args, "--tools")).toBe("read,grep,find,ls");
        expect(argumentAfter(run.args, "--model")).toBe("openrouter/z-ai/glm-5.3-flash:low");
        expect(argumentAfter(run.args, "--system-prompt")).toContain("read-only codebase exploration subagent");
        expect(run.args).not.toContain("--append-system-prompt");
        expect(run.args.at(-1)).toBe("Inspect the target");
        expect(run.limits).toEqual({
            wallClockMs: 60 * MINUTE,
            stallTimeoutMs: 10 * MINUTE,
            toolStallTimeoutMs: 15 * MINUTE,
        });
    });

    test("worker runs a write-capable child with the Ponytail guidance appended", async () => {
        const fixture = spawnHost();
        const { spawned, run } = await fixture.spawnAndWait("worker", { prompt: "Implement the target" });

        expect(spawned.details.state.agent).toBe("worker");
        expect(spawned.details.state.model).toBe("openrouter/z-ai/glm-5.3-flash:high");
        expect(argumentAfter(run.args, "--tools")).toBe("read,bash,edit,write,grep,find,ls");
        expect(argumentAfter(run.args, "--model")).toBe("openrouter/z-ai/glm-5.3-flash:high");
        const guidance = argumentAfter(run.args, "--append-system-prompt") ?? "";
        expect(guidance).toContain("Lazy means efficient, not careless.");
        expect(guidance).toContain("Bug fix = root cause, not symptom");
        expect(guidance.toLowerCase()).not.toContain("ponytail");
        expect(run.args).not.toContain("--system-prompt");
        expect(run.args.at(-1)).toBe("Implement the target");
        expect(run.limits).toEqual({
            wallClockMs: 60 * MINUTE,
            stallTimeoutMs: 10 * MINUTE,
            toolStallTimeoutMs: 15 * MINUTE,
        });
    });

    test("resolves each Profile's model from the argument, then its environment variable, then the default", async () => {
        const fixture = spawnHost({
            PI_EXPLORER_MODEL: "fixture/explorer-env",
            PI_WORKER_MODEL: "fixture/worker-env",
        });

        const explorerEnv = await fixture.spawnAndWait("explorer");
        const explorerExplicit = await fixture.spawnAndWait("explorer", { model: "fixture/explorer-explicit" });
        const workerEnv = await fixture.spawnAndWait("worker");
        const workerExplicit = await fixture.spawnAndWait("worker", { model: " fixture/worker-explicit " });

        expect(argumentAfter(explorerEnv.run.args, "--model")).toBe("fixture/explorer-env");
        expect(argumentAfter(explorerExplicit.run.args, "--model")).toBe("fixture/explorer-explicit");
        expect(argumentAfter(workerEnv.run.args, "--model")).toBe("fixture/worker-env");
        expect(argumentAfter(workerExplicit.run.args, "--model")).toBe("fixture/worker-explicit");
        expect(workerExplicit.spawned.details.state.model).toBe("fixture/worker-explicit");

        const blank = spawnHost({ PI_WORKER_MODEL: "   " });
        const fallback = await blank.spawnAndWait("worker", { model: "" });
        expect(argumentAfter(fallback.run.args, "--model")).toBe("openrouter/z-ai/glm-5.3-flash:high");
    });

    test("tool descriptions state each Profile's tools, default model, and Limits", () => {
        const { host } = spawnHost();
        const explorer = host.tool("explorer");
        const worker = host.tool("worker");

        expect(explorer.description).toContain("read, grep, find, ls");
        expect(explorer.description).toContain("openrouter/z-ai/glm-5.3-flash:low");
        expect(explorer.description).toContain("PI_EXPLORER_MODEL");
        expect(worker.description).toContain("read, bash, edit, write, grep, find, ls");
        expect(worker.description).toContain("openrouter/z-ai/glm-5.3-flash:high");
        expect(worker.description).toContain("PI_WORKER_MODEL");
        for (const tool of [explorer, worker]) {
            expect(tool.description).toContain("60 minutes");
            expect(tool.description).toContain("10 minutes");
            expect(tool.description).toContain("15 minutes");
            expect(tool.parameters.required).toEqual(["prompt", "cwd"]);
            expect(Object.keys(tool.parameters.properties)).toEqual(["prompt", "cwd", "model", "name"]);
        }
    });

    test("normalises a relative cwd, a home-relative cwd, and a stray leading @", async () => {
        const fixture = spawnHost();
        const relative = path.relative(process.cwd(), extensionCwd);

        const fromRelative = await fixture.spawnAndWait("explorer", { cwd: `@../${path.basename(extensionCwd)}` });
        expect(fromRelative.run.cwd).toBe(extensionCwd);
        expect(fromRelative.spawned.details.state.cwd).toBe(extensionCwd);

        const fromParent = await fixture.host
            .tool("explorer")
            .execute("parent-relative", { prompt: "x", cwd: relative }, undefined, undefined, { cwd: process.cwd() });
        expect(fromParent.details.state.cwd).toBe(extensionCwd);

        const fromHome = await fixture.host
            .tool("worker")
            .execute("home", { prompt: "x", cwd: "~" }, undefined, undefined, { cwd: extensionCwd });
        expect(fromHome.details.state.cwd).toBe(fs.realpathSync(os.homedir()));
    });
});

describe("subagent extension result delivery", () => {
    async function spawnOnly(fixture: ReturnType<typeof spawnHost>, profile: "explorer" | "worker" = "explorer") {
        const spawned = await fixture.host
            .tool(profile)
            .execute(`${profile}-call`, { prompt: `Use ${profile}`, cwd: extensionCwd }, undefined, undefined, {
                cwd: extensionCwd,
            });
        return spawned.details.id as string;
    }

    test("a finished Job nobody waited for sends exactly one subagent-result follow-up that triggers a turn", async () => {
        const fixture = spawnHost();
        const id = await spawnOnly(fixture);

        await waitFor(() => fixture.host.messages.length === 1, 5_000, "result was not delivered");
        await settleEventLoop();
        expect(fixture.host.messages).toHaveLength(1);
        const [message, options] = fixture.host.messages[0]!;
        expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
        expect(message.customType).toBe("subagent-result");
        expect(message.display).toBe(true);
        expect(message.details).toEqual({ id, title: "Use explorer", status: "succeeded" });
        expect(message.content).toBe(`Background subagent Use explorer (${id}) succeeded:\n\ndelegated answer`);
    });

    test("a Job consumed by subagent_wait sends no follow-up", async () => {
        const fixture = spawnHost();
        const { spawned, waited } = await fixture.spawnAndWait("worker");
        expect(waited.details.results.map((result: any) => result.id)).toEqual([spawned.details.id]);

        await settleEventLoop();
        expect(fixture.host.messages).toEqual([]);
    });

    test("subagent_check does not consume the result, so the follow-up still arrives", async () => {
        const fixture = spawnHost();
        const id = await spawnOnly(fixture);
        await fixture.host.tool("subagent_check").execute("check", { id });

        await waitFor(() => fixture.host.messages.length === 1, 5_000, "result was not delivered");
        expect(fixture.host.messages[0]![0].details).toMatchObject({ id });
    });

    test("a truncated result names the retained full-output path, and shutdown removes the file", async () => {
        const output = "x".repeat(20_000);
        const fixture = spawnHost({}, output);
        const id = await spawnOnly(fixture);

        await waitFor(() => fixture.host.messages.length === 1, 5_000, "result was not delivered");
        const [message] = fixture.host.messages[0]!;
        const content = message.content as string;
        expect(content).toContain("[Output truncated:");
        const retained = /Full output: (.+)$/m.exec(content)?.[1];
        expect(retained).toBeString();
        expect(await fs.promises.readFile(retained!, "utf8")).toBe(output);
        expect(message.details).toMatchObject({ id, status: "succeeded" });

        await fixture.host.handler("session_shutdown")({ type: "session_shutdown" }, {});
        await expect(fs.promises.stat(retained!)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("shutdown aborts a running Job without sending a late result", async () => {
        const fixture = limitsHost();
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });

        await fixture.host.handler("session_shutdown")({ type: "session_shutdown" }, {});
        await settleEventLoop();
        expect(child.signals[0]).toBe("SIGTERM");
        expect(child.closed).toBe(true);
        expect((await fixture.status(id)).status).toBe("cancelled");
        expect(fixture.host.messages).toEqual([]);
    });
});

/** A scripted child Pi process: the test writes JSONL to its stdout and decides how it answers signals. */
class ScriptedChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly pid = undefined;
    readonly signals: NodeJS.Signals[] = [];
    closed = false;
    constructor(private readonly ignoresSigterm: boolean) {
        super();
    }
    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.signals.push(signal);
        if (signal === "SIGKILL" || !this.ignoresSigterm) queueMicrotask(() => this.close(null, signal));
        return true;
    }
    close(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.closed) return;
        this.closed = true;
        this.stdout.end();
        this.stderr.end();
        this.emit("close", code, signal);
    }
    emitEvent(event: Record<string, unknown>): Promise<void> {
        this.stdout.write(`${JSON.stringify(event)}\n`);
        return settleEventLoop();
    }
}

/** An extension host running the real runner against scripted children under an injected clock. */
function limitsHost(options: { ignoresSigterm?: boolean } = {}) {
    const host = createExtensionApiHarness();
    const fake = createFakeClock();
    const children: ScriptedChild[] = [];
    const spawn: SpawnChildAgent = () => {
        const child = new ScriptedChild(options.ignoresSigterm ?? false);
        children.push(child);
        return child as unknown as ReturnType<SpawnChildAgent>;
    };
    registerSubagentExtension(host.api, {
        semaphore: new AbortableSemaphore(4),
        environment: {},
        invocation: (args) => ({ command: "fake-pi", args }),
        clock: fake.clock,
        spawn,
    });
    return {
        host,
        clock: fake,
        async spawn(profile: "explorer" | "worker" = "worker") {
            const spawned = await host
                .tool(profile)
                .execute(`${profile}-call`, { prompt: `Use ${profile}`, cwd: extensionCwd }, undefined, undefined, {
                    cwd: extensionCwd,
                });
            await waitFor(() => children.length === 1, 5_000, "child was not spawned");
            await settleEventLoop();
            return { id: spawned.details.id as string, child: children[0]! };
        },
        /** The Job's current Job state as `subagent_check` reports it. */
        status(id: string) {
            return host
                .tool("subagent_check")
                .execute("check", { id })
                .then((result: any) => result.details.state);
        },
        /** The terminal status and error the host delivered for the Job. */
        async result(id: string) {
            await host.tool("subagent_wait").execute("wait", { ids: [id] });
            const run = await this.status(id);
            return { status: run.status as string, text: (run.error ?? "") as string };
        },
    };
}

const toolStart = (id: string, timestamp: number) => ({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "bash",
    args: { command: "sleep 1" },
    timestamp,
});
const toolUpdate = (id: string, timestamp: number) => ({
    type: "tool_execution_update",
    toolCallId: id,
    toolName: "bash",
    args: { command: "sleep 1" },
    partialResult: { content: [{ type: "text", text: "still going" }] },
    timestamp,
});
const toolEnd = (id: string, timestamp: number) => ({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "bash",
    isError: false,
    timestamp,
});

describe("subagent extension Limits", () => {
    test("a child that keeps calling tools past the wall clock is ended by the wall clock Limit", async () => {
        const fixture = limitsHost();
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });

        for (let step = 0; step < 11; step++) {
            await fixture.clock.advance(5 * MINUTE);
            await child.emitEvent(toolStart(`tool-${step}`, fixture.clock.now));
            await child.emitEvent(toolEnd(`tool-${step}`, fixture.clock.now));
            expect((await fixture.status(id)).status).toBe("running");
        }
        await fixture.clock.advance(5 * MINUTE);

        const result = await fixture.result(id);
        expect(result.status).toBe("timed_out");
        expect(result.text).toContain("wall clock");
        expect(result.text).toContain("60 minute");
        expect(child.signals[0]).toBe("SIGTERM");
        const run = await fixture.status(id);
        expect(
            run.recentActivity.some((item: any) => item.kind === "diagnostic" && /wall clock/i.test(item.title)),
        ).toBe(true);
    });

    test("a child that produces no events while idle past the stall timeout is ended by the stall Limit", async () => {
        const fixture = limitsHost();
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });

        await fixture.clock.advance(9 * MINUTE);
        expect((await fixture.status(id)).status).toBe("running");
        await fixture.clock.advance(MINUTE);

        const result = await fixture.result(id);
        expect(result.status).toBe("stalled");
        expect(result.text).toContain("stall");
        expect(result.text).toContain("10 minute");
        expect(result.text).not.toContain("tool stall");
        expect(child.signals[0]).toBe("SIGTERM");
    });

    test("an active tool without output past the tool-stall timeout is ended by the tool-stall Limit; streaming output resets it", async () => {
        const fixture = limitsHost();
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });
        await child.emitEvent(toolStart("tool-a", fixture.clock.now));

        // Past the idle stall timeout, but a tool is active so the longer tool-stall Limit applies.
        await fixture.clock.advance(12 * MINUTE);
        expect((await fixture.status(id)).status).toBe("running");

        // Streaming output resets the tool-stall timer.
        await child.emitEvent(toolUpdate("tool-a", fixture.clock.now));
        await fixture.clock.advance(14 * MINUTE);
        expect((await fixture.status(id)).status).toBe("running");

        await fixture.clock.advance(MINUTE);
        const result = await fixture.result(id);
        expect(result.status).toBe("tool_stalled");
        expect(result.text).toContain("tool stall");
        expect(result.text).toContain("15 minute");
        expect(child.signals[0]).toBe("SIGTERM");
    });

    test("termination escalates SIGTERM to SIGKILL when the child ignores SIGTERM", async () => {
        const fixture = limitsHost({ ignoresSigterm: true });
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });

        await fixture.clock.advance(10 * MINUTE);
        expect(child.signals).toEqual(["SIGTERM"]);
        expect(child.closed).toBe(false);

        await fixture.clock.advance(2_000);
        expect(child.signals[1]).toBe("SIGKILL");
        expect(child.closed).toBe(true);
        expect((await fixture.result(id)).status).toBe("stalled");
    });
});

describe("subagent extension Background Protocol", () => {
    const SESSION = "session-under-test";
    async function boundHost() {
        const fixture = limitsHost();
        await fixture.host.handler("session_start")(
            { type: "session_start" },
            { sessionManager: { getSessionId: () => SESSION } },
        );
        /** Every payload emitted on the event channel, decoded by the Module's own parser. */
        const events = () =>
            fixture.host.emitted
                .filter((entry) => entry.channel === BACKGROUND_SUBAGENT_CHANNEL)
                .map((entry) => {
                    const event = parseBackgroundSubagentEvent(entry.payload);
                    if (!event) throw new Error(`Unparseable event: ${JSON.stringify(entry.payload)}`);
                    return event;
                });
        const ready = events().at(-1);
        expect(ready).toMatchObject({ type: "ready", sessionId: SESSION });
        const instanceId = ready!.instanceId;
        const cancel = (route: { sessionId?: string; instanceId?: string }, jobId: string) => {
            fixture.host.events.emit(BACKGROUND_SUBAGENT_CONTROL_CHANNEL, {
                schema: BACKGROUND_SUBAGENT_CONTROL_SCHEMA,
                version: BACKGROUND_SUBAGENT_VERSION,
                sessionId: SESSION,
                instanceId,
                type: "cancel",
                jobId,
                ...route,
            });
            return settleEventLoop();
        };
        return { ...fixture, events, instanceId, cancel };
    }
    const statusesOf = (events: BackgroundSubagentEventV1[], id: string) =>
        events
            .filter((event) => event.type === "upsert" && event.job?.id === id)
            .map((event) => event.job!.state.status);

    test("every Job transition is an upsert on the event channel, and session_shutdown emits a reset", async () => {
        const fixture = await boundHost();
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });
        await child.emitEvent({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Final child report" }],
                model: "fixture/model",
                stopReason: "stop",
                timestamp: fixture.clock.now,
            },
            timestamp: fixture.clock.now,
        });
        child.close(0, null);
        await fixture.result(id);

        const upserts = fixture.events().filter((event) => event.type === "upsert" && event.job?.id === id);
        for (const event of upserts) {
            expect(event).toMatchObject({
                schema: BACKGROUND_SUBAGENT_SCHEMA,
                version: BACKGROUND_SUBAGENT_VERSION,
                sessionId: SESSION,
                instanceId: fixture.instanceId,
            });
        }
        const statuses = statusesOf(fixture.events(), id);
        expect(statuses[0]).toBe("queued");
        expect(statuses).toContain("running");
        expect(statuses.at(-1)).toBe("succeeded");
        expect(statuses.indexOf("running")).toBeLessThan(statuses.lastIndexOf("succeeded"));
        expect(fixture.events().some((event) => event.type === "reset")).toBe(false);

        await fixture.host.handler("session_shutdown")({ type: "session_shutdown" }, {});
        expect(fixture.events().at(-1)).toMatchObject({
            schema: BACKGROUND_SUBAGENT_SCHEMA,
            version: BACKGROUND_SUBAGENT_VERSION,
            type: "reset",
            sessionId: SESSION,
            instanceId: fixture.instanceId,
        });
    });

    test("a cancel control message is ignored unless both its session id and instance id match", async () => {
        const fixture = await boundHost();
        const { id, child } = await fixture.spawn();
        await child.emitEvent({ type: "turn_start", turnIndex: 0, timestamp: fixture.clock.now });
        expect(statusesOf(fixture.events(), id).at(-1)).toBe("running");

        await fixture.cancel({ sessionId: "another-session" }, id);
        await fixture.cancel({ instanceId: "another-instance" }, id);
        expect(child.signals).toEqual([]);
        expect(statusesOf(fixture.events(), id).at(-1)).toBe("running");

        await fixture.cancel({}, id);
        await fixture.result(id);
        expect(child.signals[0]).toBe("SIGTERM");
        expect(statusesOf(fixture.events(), id).at(-1)).toBe("cancelled");
    });
});
