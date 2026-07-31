import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workflowApprovalKey } from "./approval.js";
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

const workflowFile = (body = "return args;") =>
    `export default async function workflow(_context: unknown, args: unknown) { ${body} }`;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow extension event.");
        await Bun.sleep(5);
    }
}

describe("workflow extension", () => {
    test("injects authoring documentation only for workflow-writing requests", () => {
        const f = fixture();
        const beforeAgentStart = f.handlers.get("before_agent_start")!;

        for (const prompt of [
            "Create a TypeScript workflow for reviews",
            "How do I write workflows?",
            "Please create a workflow.",
            "This workflow, I'd like you to write",
        ]) {
            const result = beforeAgentStart({ prompt, systemPrompt: "base prompt" });
            expect(result.systemPrompt).toStartWith("base prompt\n\n# Writing pui workflows");
            expect(result.systemPrompt).toContain("default-export one **named async function**");
            expect(result.systemPrompt).toContain("WorkflowContext");
        }

        for (const prompt of [
            "Run the workflow in review.ts",
            "Inspect the active workflow",
            "Create a TypeScript utility",
            "Write the release notes",
            "Write documentation about workflows",
            "Explain workflow creation",
        ]) {
            expect(beforeAgentStart({ prompt, systemPrompt: "base prompt" })).toBeUndefined();
        }
    });

    test("registration, confirmation, launch, events, deduplication, and shutdown", async () => {
        const approvals = new Set<string>();
        const f = fixture({
            approvalStore: {
                has: async (key: string) => approvals.has(key),
                add: async (key: string) => {
                    approvals.add(key);
                },
            },
        });
        expect(f.tool.name).toBe("workflow");
        expect(f.tool.description).toContain("shell()");
        expect(f.tool.parameters.properties.script.description).toContain("TypeScript");
        await f.handlers.get("session_start")!(
            {},
            { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-1" } },
        );
        expect(f.emitted.at(-1)?.[1].type).toBe("ready");
        const script = "await agent('exact'); return await shell('check')";
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
        expect(confirmation).toContain("Visible agent calls: 1");
        expect(confirmation).toContain("Visible shell calls: 1");
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

    test("keeps recovered headless runs out of TUI delivery and recovery", async () => {
        let recoveryPrompts = 0;
        const headlessFailed = {
            ...summary("succeeded"),
            sessionId: "headless-7e2646bb-a375-4e8d-8a70-3c352d2e91cc",
            status: "failed" as const,
            error: "headless failure",
        };
        const headlessInterrupted = {
            ...summary("running"),
            id: "run-interrupted",
            sessionId: "headless-8f3757cc-b486-4f9e-9b81-4d463e3f02dd",
            status: "paused" as const,
        };
        const f = fixture({
            backend: {
                initialize: async () => [headlessFailed, headlessInterrupted],
                list: () => [headlessFailed, headlessInterrupted],
            },
        });

        await f.handlers.get("session_start")!(
            {},
            {
                cwd: process.cwd(),
                sessionManager: { getSessionId: () => "session-1" },
                ui: {
                    select: async () => {
                        recoveryPrompts++;
                        return "Resume";
                    },
                    notify: () => {},
                },
            },
        );

        expect(f.messages).toEqual([]);
        expect(recoveryPrompts).toBe(0);
        expect(f.emitted.filter(([, value]) => value.type === "upsert")).toEqual([]);
        await f.handlers.get("session_shutdown")!();
    });

    test("ignores metadata-like text when naming inline workflows", async () => {
        const f = fixture({ approvalStore: { has: async () => true, add: async () => {} } });
        await f.handlers.get("session_start")!(
            {},
            { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-1" } },
        );
        const script = `// export const meta={name:"wrong",description:"Wrong"}\nreturn 1`;
        await f.tool.execute("id", { script }, undefined, undefined, { cwd: process.cwd(), ui: {} });
        expect(f.launches.at(-1)).toMatchObject({ name: "Inline workflow", script });
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

    test("command accepts quoted paths with JSON args and preserves unquoted paths", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-command-"));
        try {
            await Promise.all([
                fs.promises.writeFile(path.join(root, "single quoted.ts"), workflowFile()),
                fs.promises.writeFile(path.join(root, "double quoted.ts"), workflowFile()),
                fs.promises.writeFile(path.join(root, "plain.ts"), workflowFile()),
            ]);
            const f = fixture({ approvalStore: { has: async () => true, add: async () => {} } });
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-1" } },
            );
            const notifications: string[] = [];
            const context = { cwd: root, ui: { notify: (message: string) => notifications.push(message) } };
            await f.command.handler("   ", context);
            expect(notifications).toEqual(["Usage: /workflow <path> [JSON args]"]);
            await f.command.handler(`'single quoted.ts' {"quote":"single"}`, context);
            await f.command.handler(`"double quoted.ts" {"quote":"double"}`, context);
            await f.command.handler(`plain.ts {"quote":"none"}`, context);
            expect(f.launches.map(({ name, args }) => ({ name, args }))).toEqual([
                { name: "single-quoted", args: { quote: "single" } },
                { name: "double-quoted", args: { quote: "double" } },
                { name: "plain", args: { quote: "none" } },
            ]);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("aborts a launch when the session changes while approval is pending", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-approval-session-"));
        let resolveApproval: (approved: boolean) => void = () => {},
            markConfirmationPending: () => void = () => {};
        const approval = new Promise<boolean>((resolve) => (resolveApproval = resolve)),
            confirmationPending = new Promise<void>((resolve) => (markConfirmationPending = resolve));
        try {
            await fs.promises.writeFile(path.join(root, "pending.ts"), workflowFile("return 1;"));
            const f = fixture({ approvalStore: { has: async () => false, add: async () => {} } });
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-1" } },
            );
            const launch = f.tool.execute("id", { path: "pending.ts" }, undefined, undefined, {
                cwd: root,
                ui: {
                    confirm: () => {
                        markConfirmationPending();
                        return approval;
                    },
                },
            });
            await confirmationPending;
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-2" } },
            );
            resolveApproval(true);
            await expect(launch).rejects.toThrow("active session changed");
            expect(f.launches).toHaveLength(0);
        } finally {
            resolveApproval(false);
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("aborts an inline launch when the session changes during backend setup", async () => {
        let setupStarted: () => void = () => {};
        let releaseSetup: () => void = () => {};
        const started = new Promise<void>((resolve) => (setupStarted = resolve));
        const release = new Promise<void>((resolve) => (releaseSetup = resolve));
        const f = fixture({
            backend: {
                async launch(_input, signal) {
                    setupStarted();
                    await release;
                    if (signal?.aborted) throw new Error("Workflow launch was cancelled.");
                    return { runId: "stale" };
                },
            },
        });
        await f.handlers.get("session_start")!(
            {},
            { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-1" } },
        );
        const launch = f.tool.execute("id", { script: "return 1" }, undefined, undefined, {
            cwd: process.cwd(),
            ui: { confirm: () => true },
        });
        await started;
        await f.handlers.get("session_start")!(
            {},
            { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-2" } },
        );
        releaseSetup();
        await expect(launch).rejects.toThrow("cancelled");
    });

    test("launches an explicit file outside a repository without project trust", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-file-"));
        try {
            const script = workflowFile();
            await fs.promises.writeFile(path.join(root, "plain workflow.ts"), script);
            const f = fixture({
                approvalStore: { has: async () => false, add: async () => {} },
            });
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-1" } },
            );
            await f.tool.execute("id", { path: "plain workflow.ts", args: { x: 1 } }, undefined, undefined, {
                cwd: root,
                isProjectTrusted: () => false,
                ui: { confirm: () => true },
            });
            expect(f.launches.at(-1)).toMatchObject({
                name: "plain-workflow",
                args: { x: 1 },
                script,
                entrypoint: "function",
            });
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
            const file = path.join(root, "demo.ts");
            const exactScript = `\uFEFFexport const meta={name:"demo",description:"Demo"};\r\nexport default async function workflow(_context: unknown, args: unknown) {\r\n    const value: unknown = args;\r\n    return value;\r\n}`;
            await fs.promises.writeFile(file, Buffer.from(exactScript, "utf8"));
            const f = fixture({ approvalStore });
            await f.handlers.get("session_start")!(
                {},
                { cwd: root, sessionManager: { getSessionId: () => "session-1" } },
            );
            let confirmations = 0;
            const context = {
                cwd: root,
                isProjectTrusted: () => false,
                ui: {
                    confirm: () => {
                        confirmations++;
                        return true;
                    },
                    select: () => {
                        throw new Error("Unexpected post-acceptance prompt");
                    },
                    notify: () => {},
                },
            };
            await expect(
                f.tool.execute("id", { path: "demo.ts", args: { x: 1 } }, undefined, undefined, context),
            ).rejects.toThrow("not trusted");
            context.isProjectTrusted = () => true;
            await f.tool.execute("id", { path: "demo.ts", args: { x: 1 } }, undefined, undefined, context);
            expect(f.launches.at(-1)).toMatchObject({
                name: "demo",
                args: { x: 1 },
                script: exactScript,
                entrypoint: "function",
            });
            expect(keys).toContain(
                workflowApprovalKey(await fs.promises.realpath(root), await fs.promises.realpath(file), exactScript),
            );
            const approved = keys.size;
            expect(confirmations).toBe(1);
            await f.command.handler(`demo.ts {"from":"command"}`, context);
            expect(keys.size).toBe(approved);
            expect(confirmations).toBe(1);
            const moved = path.join(root, "moved.ts");
            await fs.promises.copyFile(file, moved);
            await f.tool.execute("id", { path: moved }, undefined, undefined, context);
            expect(keys.size).toBe(approved + 1);
            await fs.promises.writeFile(
                file,
                `export const meta={name:"demo",description:"Changed"}; ${workflowFile()}`,
            );
            await f.tool.execute("id", { path: file }, undefined, undefined, context);
            expect(keys.size).toBe(approved + 2);
            expect(confirmations).toBe(3);
            await expect(
                f.tool.execute("id", { path: file, script: "return 1" }, undefined, undefined, context),
            ).rejects.toThrow("exactly one");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });
});
