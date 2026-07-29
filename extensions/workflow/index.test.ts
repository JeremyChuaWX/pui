import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowBackend } from "./backend.js";
import { registerWorkflowExtension } from "./index.js";

const summary = (status: "running" | "succeeded") => ({
    schema: "pi.workflow" as const,
    version: 1 as const,
    id: "run-1",
    name: "demo",
    sessionId: "session-1",
    cwd: process.cwd(),
    status,
    phases: [],
    agents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    limits: { maxConcurrency: 4, maxAgents: 1000, timeoutMs: 600000, maxTokens: 0, maxCost: 0 },
    recentActivity: [],
    updatedAt: 1,
});

function fixture(dependencies: { backend?: Partial<WorkflowBackend>; [key: string]: unknown } = {}) {
    const handlers = new Map<string, (...args: any[]) => any>(),
        eventHandlers = new Map<string, (payload: any) => void>(),
        emitted: any[] = [],
        messages: any[] = [],
        launches: any[] = [];
    let tool: any,
        command: any,
        listener: ((run: any) => void) | undefined,
        shutdowns = 0;
    const defaultBackend: WorkflowBackend = {
        async launch(input) {
            launches.push(input);
            return { runId: "run-1" };
        },
        list: () => [],
        inspect: () => ({ run: summary("succeeded"), script: "return 1", result: "1" }),
        subscribe(fn) {
            listener = fn;
            return () => {
                listener = undefined;
            };
        },
        async control() {
            return undefined;
        },
        async shutdown() {
            shutdowns++;
        },
    };
    const { backend: backendOverrides, ...extensionDependencies } = dependencies,
        backend: WorkflowBackend = { ...defaultBackend, ...backendOverrides };
    const pi: any = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        registerTool: (value: any) => {
            tool = value;
        },
        registerCommand: (_name: string, value: any) => {
            command = value;
        },
        sendMessage: (message: any) => messages.push(message),
        events: {
            emit: (channel: string, payload: any) => emitted.push([channel, payload]),
            on: (channel: string, fn: (payload: any) => void) => {
                eventHandlers.set(channel, fn);
                return () => eventHandlers.delete(channel);
            },
        },
    };
    registerWorkflowExtension(pi, {
        backend,
        environment: {},
        instanceId: "instance-1",
        ...extensionDependencies,
    });
    return {
        handlers,
        eventHandlers,
        emitted,
        messages,
        launches,
        backend,
        get tool() {
            return tool;
        },
        get command() {
            return command;
        },
        emitRun: (run: any) => listener?.(run),
        shutdowns: () => shutdowns,
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow extension event.");
        await Bun.sleep(5);
    }
}

describe("workflow extension", () => {
    test("registration, confirmation, launch, events, deduplication, and shutdown", async () => {
        const f = fixture();
        expect(f.tool.name).toBe("workflow");
        await f.handlers.get("session_start")!(
            {},
            { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-1" } },
        );
        expect(f.emitted.at(-1)?.[1].type).toBe("ready");
        const script = "return await agent('exact')";
        let confirmation = "";
        await expect(
            f.tool.execute("id", { script }, undefined, undefined, {
                cwd: process.cwd(),
                ui: {
                    confirm: (_t: string, body: string) => {
                        confirmation = body;
                        return false;
                    },
                },
            }),
        ).rejects.toThrow("denied");
        expect(confirmation).toContain(script);
        expect(f.launches).toHaveLength(0);
        await f.tool.execute("id", { script }, undefined, undefined, {
            cwd: process.cwd(),
            ui: { confirm: () => true },
        });
        expect(f.launches[0]).toMatchObject({ script, sessionId: "session-1", cwd: process.cwd() });
        f.emitRun(summary("running"));
        expect(f.emitted.at(-1)?.[1]).toMatchObject({ type: "upsert", run: { id: "run-1" } });
        f.emitRun(summary("succeeded"));
        f.emitRun(summary("succeeded"));
        expect(f.messages.filter((m) => m.customType === "workflow-result")).toHaveLength(1);
        await f.handlers.get("session_shutdown")!();
        expect(f.shutdowns()).toBe(1);
        expect(f.emitted.at(-1)?.[1].type).toBe("reset");
    });

    test("publishes readiness only for the latest overlapping session start", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-lifecycle-")),
            firstCwd = path.join(root, "first"),
            secondCwd = path.join(root, "second");
        await fs.promises.mkdir(firstCwd);
        await fs.promises.mkdir(secondCwd);
        let initializeCalls = 0,
            resolveStarted: () => void = () => {},
            resolveInitialization: () => void = () => {};
        const started = new Promise<void>((resolve) => (resolveStarted = resolve)),
            initialization = new Promise<void>((resolve) => (resolveInitialization = resolve));
        const f = fixture({
            backend: {
                async initialize() {
                    initializeCalls++;
                    if (initializeCalls === 1) {
                        resolveStarted();
                        await initialization;
                    }
                    return [];
                },
            },
        });
        try {
            const first = f.handlers.get("session_start")!(
                {},
                { cwd: firstCwd, sessionManager: { getSessionId: () => "session-first" } },
            );
            await started;
            const second = f.handlers.get("session_start")!(
                {},
                { cwd: secondCwd, sessionManager: { getSessionId: () => "session-second" } },
            );
            resolveInitialization();
            await Promise.all([first, second]);
            expect(initializeCalls).toBe(2);
            expect(f.emitted.filter(([, value]) => value.type === "ready").map(([, value]) => value)).toEqual([
                expect.objectContaining({
                    sessionId: "session-second",
                    cwd: await fs.promises.realpath(secondCwd),
                }),
            ]);
        } finally {
            resolveInitialization();
            await f.handlers.get("session_shutdown")!();
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("launches an explicit file outside a repository without project trust", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-file-"));
        try {
            await fs.promises.writeFile(path.join(root, "plain workflow.js"), "return args");
            const f = fixture({
                approvalStore: { has: async () => false, add: async () => {} },
            });
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-1" } },
            );
            await f.tool.execute("id", { path: "plain workflow.js", args: { x: 1 } }, undefined, undefined, {
                cwd: root,
                isProjectTrusted: () => false,
                ui: { confirm: () => true },
            });
            expect(f.launches.at(-1)).toMatchObject({ name: "plain-workflow", args: { x: 1 }, script: "return args" });
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("control channel remains and save bridge is removed", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-events-"));
        try {
            const f = fixture({
                backend: {
                    async control() {
                        return { runId: "linked-run" };
                    },
                },
            });
            await f.handlers.get("session_start")!(
                {},
                {
                    cwd: root,
                    sessionManager: { getSessionId: () => "session-1" },
                    ui: { select: async () => "Later", notify: () => {} },
                },
            );
            expect(f.eventHandlers.has("pui.workflow.background.save")).toBe(false);
            f.eventHandlers.get("pui.workflow.background.control")!({
                schema: "pi.workflow.background.control",
                version: 1,
                sessionId: "session-1",
                instanceId: "instance-1",
                cwd: await fs.promises.realpath(root),
                requestId: "control-ok",
                runId: "run-1",
                action: "pause",
            });
            await waitFor(() => f.emitted.some(([, value]) => value.requestId === "control-ok"));
            expect(f.emitted.find(([, value]) => value.requestId === "control-ok")?.[1]).toMatchObject({
                ok: true,
                linkedRunId: "linked-run",
            });
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("file invocation passes args, requires project trust, and reapproves changed bytes", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-index-"));
        const keys = new Set<string>();
        const approvalStore = {
            has: async (key: string) => keys.has(key),
            add: async (key: string) => {
                keys.add(key);
            },
        };
        try {
            await fs.promises.mkdir(path.join(root, ".git"));
            const file = path.join(root, "demo.js");
            await fs.promises.writeFile(file, `export const meta={name:"demo",description:"Demo"}; return args`);
            const f = fixture({ approvalStore });
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-1" } },
            );
            const context = {
                cwd: root,
                isProjectTrusted: () => false,
                ui: { confirm: () => true, select: () => "Trust unchanged script in this project", notify: () => {} },
            };
            await expect(
                f.tool.execute("id", { path: "demo.js", args: { x: 1 } }, undefined, undefined, context),
            ).rejects.toThrow("not trusted");
            context.isProjectTrusted = () => true;
            await f.tool.execute("id", { path: "demo.js", args: { x: 1 } }, undefined, undefined, context);
            expect(f.launches.at(-1)).toMatchObject({
                name: "demo",
                args: { x: 1 },
                script: expect.stringContaining("return args"),
            });
            const approved = keys.size;
            await f.command.handler(`demo.js {"from":"command"}`, context);
            expect(keys.size).toBe(approved);
            const moved = path.join(root, "moved.js");
            await fs.promises.copyFile(file, moved);
            await f.tool.execute("id", { path: moved }, undefined, undefined, context);
            expect(keys.size).toBe(approved + 1);
            await fs.promises.writeFile(file, `export const meta={name:"demo",description:"Changed"}; return args`);
            await f.tool.execute("id", { path: file }, undefined, undefined, context);
            expect(keys.size).toBe(approved + 2);
            await expect(
                f.tool.execute("id", { path: file, script: "return 1" }, undefined, undefined, context),
            ).rejects.toThrow("exactly one");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });
});
