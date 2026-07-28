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

function fixture(enabled: boolean, dependencies: Record<string, unknown> = {}) {
    const handlers = new Map<string, (...args: any[]) => any>(),
        emitted: any[] = [],
        messages: any[] = [],
        launches: any[] = [];
    let tool: any,
        command: any,
        listener: ((run: any) => void) | undefined,
        shutdowns = 0;
    const backend: WorkflowBackend = {
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
    const pi: any = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        registerTool: (value: any) => {
            tool = value;
        },
        registerCommand: (_name: string, value: any) => {
            command = value;
        },
        sendMessage: (message: any) => messages.push(message),
        events: { emit: (channel: string, payload: any) => emitted.push([channel, payload]), on: () => () => {} },
    };
    registerWorkflowExtension(pi, {
        backend,
        environment: enabled ? { PUI_WORKFLOWS: "1" } : {},
        instanceId: "instance-1",
        ...dependencies,
    });
    return {
        handlers,
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

describe("workflow extension", () => {
    test("feature flag, confirmation, launch, events, deduplication, and shutdown", async () => {
        expect(fixture(false).tool).toBeUndefined();
        const f = fixture(true);
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

    test("saved invocation passes structured args, requires project trust, completes commands, and reapproves changed bytes", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-index-"));
        const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-index-home-"));
        const keys = new Set<string>();
        const approvalStore = {
            has: async (key: string) => keys.has(key),
            add: async (key: string) => {
                keys.add(key);
            },
        };
        try {
            await fs.promises.mkdir(path.join(root, ".git"));
            await fs.promises.mkdir(path.join(root, ".pi/workflows"), { recursive: true });
            const file = path.join(root, ".pi/workflows/demo.js");
            await fs.promises.writeFile(file, `export const meta={name:"demo",description:"Demo"}; return args`);
            const f = fixture(true, { storageOptions: { home }, approvalStore });
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
                f.tool.execute("id", { name: "demo", args: { x: 1 } }, undefined, undefined, context),
            ).rejects.toThrow("not trusted");
            context.isProjectTrusted = () => true;
            await f.tool.execute("id", { name: "demo", args: { x: 1 } }, undefined, undefined, context);
            expect(f.launches.at(-1)).toMatchObject({ name: "demo", args: { x: 1 } });
            expect(await f.command.getArgumentCompletions("de")).toEqual([expect.objectContaining({ value: "demo" })]);
            const approved = keys.size;
            await f.command.handler(`demo {"from":"command"}`, context);
            expect(keys.size).toBe(approved);
            await fs.promises.writeFile(file, `export const meta={name:"demo",description:"Changed"}; return args`);
            await f.tool.execute("id", { name: "demo" }, undefined, undefined, context);
            expect(keys.size).toBe(approved + 1);
            await expect(
                f.tool.execute("id", { name: "demo", script: "return 1" }, undefined, undefined, context),
            ).rejects.toThrow("exactly one");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
            await fs.promises.rm(home, { recursive: true, force: true });
        }
    });
});
