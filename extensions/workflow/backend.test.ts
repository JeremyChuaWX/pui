import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitFor } from "../test-support/wait.js";
import type { WorkflowBackendOptions } from "./backend.js";
import { createWorkflowBackend as createBackend, preflightWorkflow, resolveWorkflowNode } from "./backend.js";
import { parseWorkflowRunV1 } from "./protocol.js";
import { WorkflowRunStorage } from "./run-storage.js";

// Legacy backend fixtures intentionally exercise the unsafe shared-checkout mode.
const createWorkflowBackend = (options: WorkflowBackendOptions) =>
    createBackend({ ...options, policy: { allowUnsafeSharedCheckout: true, ...options.policy } });

beforeAll(async () => {
    await resolveWorkflowNode();
});

describe("workflow backend", () => {
    test("preflight rejects ambient authority and dynamic code", () => {
        for (const script of [
            "process.env.X",
            "require('fs')",
            "import('fs')",
            "eval('1')",
            "Function('')()",
            "fetch('https://x')",
        ])
            expect(() => preflightWorkflow(script)).toThrow("forbidden");
        expect(
            preflightWorkflow("phase('one'); for(let i=0;i<2;i++) await agent(String(i)); await shell('true')"),
        ).toEqual({
            phases: ["one"],
            agents: 1,
            shells: 1,
        });
    });
    test("preflight ignores inert capability words but scans template expressions", () => {
        const script = `// process require import Function child_process\nlog("process import Function"); log(\`child_process ${"text"}\`)`;
        expect(preflightWorkflow(script).agents).toBe(0);
        expect(() => preflightWorkflow("log(`ordinary $" + "{globalThis['pro'+'cess']}`)")).not.toThrow();
        expect(() => preflightWorkflow("log(`ordinary $" + "{process.env}`)")).toThrow("forbidden");
        expect(() => preflightWorkflow("log(/process|import|fetch|[{}]/.source)")).not.toThrow();
        expect(() =>
            preflightWorkflow(
                `const words = /process|import|export|[{}]/; export default async function workflow() { return words.source }`,
                "function",
            ),
        ).not.toThrow();
        expect(() => preflightWorkflow("/* Function */ import('fs')")).toThrow("forbidden");
        expect(() => preflightWorkflow("let value = 1; value++ / fetch('https://x')")).toThrow("forbidden");
        expect(() => preflightWorkflow("let value = 1; value -- / process.pid")).toThrow("forbidden");
    });
    test("preflight ignores forbidden names in erasable type declarations", () => {
        const script = `interface RuntimeShape { fetch: unknown; process: unknown; }
type Loader = { require: unknown; child_process: unknown };
const value: RuntimeShape | Loader | null = null;
return value;`;
        expect(() => preflightWorkflow(script)).not.toThrow();
        expect(() => preflightWorkflow(`${script}\nfetch("https://example.com")`)).toThrow("forbidden");
        expect(() => preflightWorkflow("const type = fetch();")).toThrow("forbidden");
    });
    test("shutdown cancels and waits for a launch still resolving its repository", async () => {
        let releaseRepository: () => void = () => {},
            markRepositoryStarted: () => void = () => {};
        const repositoryStarted = new Promise<void>((resolve) => (markRepositoryStarted = resolve)),
            repositoryRelease = new Promise<void>((resolve) => (releaseRepository = resolve)),
            backend = createWorkflowBackend({
                agentExecutor: async () => ({ value: null }),
                worktreeManager: {
                    async repository(cwd: string) {
                        markRepositoryStarted();
                        await repositoryRelease;
                        return cwd;
                    },
                } as never,
            }),
            launch = backend.launch({
                name: "pending",
                script: "return 1",
                sessionId: "session",
                cwd: process.cwd(),
            });
        let shutdown: Promise<void> | undefined;
        try {
            await repositoryStarted;
            let shutdownFinished = false;
            shutdown = backend.shutdown().then(() => {
                shutdownFinished = true;
            });
            await Bun.sleep(0);
            expect(shutdownFinished).toBe(false);
            releaseRepository();
            await expect(launch).rejects.toThrow("shutting down");
            await shutdown;
            expect(backend.list()).toEqual([]);
            await expect(
                backend.launch({ name: "late", script: "return 1", sessionId: "session", cwd: process.cwd() }),
            ).rejects.toThrow("shutting down");
        } finally {
            releaseRepository();
            await shutdown;
        }
    });
    test("bounds shutdown waiting for a pending launch", async () => {
        let releaseRepository: () => void = () => {},
            markRepositoryStarted: () => void = () => {};
        const repositoryStarted = new Promise<void>((resolve) => (markRepositoryStarted = resolve)),
            repositoryRelease = new Promise<void>((resolve) => (releaseRepository = resolve)),
            backend = createWorkflowBackend({
                platform: { shutdownGraceMs: 20 },
                agentExecutor: async () => ({ value: null }),
                worktreeManager: {
                    async repository(cwd: string) {
                        markRepositoryStarted();
                        await repositoryRelease;
                        return cwd;
                    },
                } as never,
            }),
            launch = backend.launch({
                name: "pending",
                script: "return 1",
                sessionId: "session",
                cwd: process.cwd(),
            });
        try {
            await repositoryStarted;
            await backend.shutdown();
            expect(backend.list()).toEqual([]);
        } finally {
            releaseRepository();
            await expect(launch).rejects.toThrow("shutting down");
        }
    });
    test("cancellation during durable setup removes the unregistered run", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-cancel-"));
        const project = path.join(temp, "project");
        await fs.promises.mkdir(project);
        const storage = new WorkflowRunStorage(path.join(temp, "runs"));
        const create = storage.create.bind(storage);
        let releaseCreate: () => void = () => {};
        let createdDirectory = "";
        const createRelease = new Promise<void>((resolve) => (releaseCreate = resolve));
        storage.create = async (...args) => {
            createdDirectory = await create(...args);
            await createRelease;
            return createdDirectory;
        };
        const backend = createWorkflowBackend({ storage, agentExecutor: async () => ({ value: null }) });
        const controller = new AbortController();
        try {
            const launch = backend.launch(
                { name: "cancelled", script: "return 1", sessionId: "session", cwd: project },
                controller.signal,
            );
            await waitFor(() => Boolean(createdDirectory));
            controller.abort();
            releaseCreate();
            await expect(launch).rejects.toThrow("cancelled");
            expect(backend.list()).toEqual([]);
            await expect(fs.promises.stat(createdDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            releaseCreate();
            await backend.shutdown();
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });
    test("storage completion failure removes the unregistered durable run", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-complete-failure-"));
        const project = path.join(temp, "project");
        await fs.promises.mkdir(project);
        const storage = new WorkflowRunStorage(path.join(temp, "runs"));
        let createdDirectory = "";
        const create = storage.create.bind(storage);
        storage.create = async (...args) => {
            createdDirectory = await create(...args);
            return createdDirectory;
        };
        storage.complete = async () => {
            throw new Error("deliberate completion failure");
        };
        const backend = createWorkflowBackend({ storage, agentExecutor: async () => ({ value: null }) });
        try {
            await expect(
                backend.launch({
                    name: "failed",
                    script: "return 1",
                    sessionId: "session",
                    cwd: project,
                    seedCompletions: new Map([["agent-seed", "value"]]),
                }),
            ).rejects.toThrow("deliberate completion failure");
            expect(backend.list()).toEqual([]);
            await expect(fs.promises.stat(createdDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await backend.shutdown();
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });
    test("reports missing and old external Node actionably", async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-node-"));
        const old = path.join(dir, process.platform === "win32" ? "node.cmd" : "node");
        await fs.promises.writeFile(
            old,
            process.platform === "win32" ? "@echo off\r\necho v20.0.0\r\n" : "#!/bin/sh\necho v20.0.0\n",
            { mode: 0o755 },
        );
        try {
            await expect(
                resolveWorkflowNode({
                    environment: { PUI_WORKFLOW_NODE: old, PATH: "" },
                    configuredPath: process.platform === "win32" ? "C:\\missing-node.exe" : "/missing-node",
                }),
            ).rejects.toThrow(/Node >=22\.19.*found v20/);
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });
    test("runs real external Node with loops, conditionals, parallel, pipeline, schema retry, and no paid model", async () => {
        let attempts = 0;
        const backend = createWorkflowBackend({
            agentExecutor: async (request) => {
                attempts++;
                if (request.prompt === "repair" && attempts === 1) return { value: { bad: true } };
                return { value: request.prompt === "repair" ? { ok: true } : request.prompt.toUpperCase() };
            },
        });
        const events: any[] = [];
        backend.subscribe((run) => events.push(run));
        const { runId } = await backend.launch({
            name: "fixture",
            script: `phase("work"); log("starting"); const repaired=await agent("repair",{retries:1,schema:{type:"object",required:["ok"],properties:{ok:{type:"boolean"}}}}); const xs=[]; for(let i=0;i<2;i++) if(i>=0) xs.push(i); const piped=await pipeline(xs,x=>agent(String(x)),{concurrency:2}); const keyed=await parallel({a:agent("a"),b:agent("b")}); return {repaired,piped,keyed,args};`,
            args: { fixture: true },
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({
            repaired: { ok: true },
            piped: ["0", "1"],
            keyed: { a: "A", b: "B" },
            args: { fixture: true },
        });
        expect(events.some((e) => e.status === "running")).toBe(true);
        expect(attempts).toBe(6);
        await backend.shutdown();
    });
    test("reports oversized agent prompts actionably without invoking an agent", async () => {
        let executions = 0;
        const backend = createWorkflowBackend({
            agentExecutor: async () => {
                executions++;
                return { value: null };
            },
        });
        const { runId } = await backend.launch({
            name: "oversized agent prompt",
            script: `await agent(${JSON.stringify("x".repeat(8_001))})`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "failed");
        expect(backend.inspect(runId).run.error).toBe(
            "Agent prompt exceeds the 8,000-byte limit (received 8,001 bytes).",
        );
        expect(executions).toBe(0);
        await backend.shutdown();
    });
    test("drains sibling RPCs before reporting a concurrent workflow failure", async () => {
        let finishSlow: () => void = () => {};
        const slow = new Promise<{ value: null }>((resolve) => {
            finishSlow = () => resolve({ value: null });
        });
        const backend = createWorkflowBackend({ agentExecutor: async () => slow });
        try {
            const { runId } = await backend.launch({
                name: "concurrent failure",
                script: `try { await Promise.all([agent("slow"),agent(${JSON.stringify("x".repeat(8_001))})]) } catch (error) { await log("sibling failure handled"); throw error }`,
                sessionId: "s",
                cwd: process.cwd(),
            });
            await waitFor(() =>
                backend
                    .inspect(runId)
                    .run.recentActivity.some((activity) => activity.title === "sibling failure handled"),
            );
            expect(backend.inspect(runId).run.status).toBe("running");
            finishSlow();
            await waitFor(() => backend.inspect(runId).run.status === "failed");
            const run = backend.inspect(runId).run;
            expect(run.error).toBe("Agent prompt exceeds the 8,000-byte limit (received 8,001 bytes).");
            expect(run.agents[0]?.status).toBe("succeeded");
        } finally {
            finishSlow();
            await backend.shutdown();
        }
    });
    test("runs host shell commands directly and returns nonzero exits", async () => {
        const node = await resolveWorkflowNode();
        const executable = process.platform === "win32" ? `"${node}"` : JSON.stringify(node);
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
        const { runId } = await backend.launch({
            name: "shell",
            script: `return await shell(${JSON.stringify(
                `${executable} -e "process.stdout.write('out');process.stderr.write('err');process.exitCode=3"`,
            )})`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
        expect(backend.inspect(runId).run.agents).toEqual([]);
        expect(backend.inspect(runId).run.recentActivity.at(-1)?.title).toContain("process.stdout.write");
        await backend.shutdown();
    });
    test("limits concurrent shell commands", async () => {
        let active = 0;
        let peak = 0;
        const backend = createWorkflowBackend({
            agentExecutor: async () => ({ value: null }),
            shellExecutor: async () => {
                active++;
                peak = Math.max(peak, active);
                await Bun.sleep(20);
                active--;
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        });
        const { runId } = await backend.launch({
            name: "bounded shells",
            script: `return await parallel([shell("a"), shell("b"), shell("c"), shell("d")])`,
            sessionId: "s",
            cwd: process.cwd(),
            limits: { maxConcurrency: 2 },
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(peak).toBe(2);
        await backend.shutdown();
    });
    test("caps shell invocations", async () => {
        let executions = 0;
        const backend = createWorkflowBackend({
            agentExecutor: async () => ({ value: null }),
            shellExecutor: async () => {
                executions++;
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        });
        const { runId } = await backend.launch({
            name: "capped shells",
            script: `for (let i = 0; i < 1001; i++) await shell(String(i))`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "failed", 15_000);
        expect(executions).toBe(1_000);
        expect(backend.inspect(runId).run.error).toContain("shell cap exceeded");
        await backend.shutdown();
    });
    test.skipIf(process.platform === "win32")("times out shell commands and reaps their process groups", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-shell-timeout-"));
        const pidFile = path.join(temp, "descendant.pid");
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
        try {
            const { runId } = await backend.launch({
                name: "shell timeout",
                script: `await shell(${JSON.stringify(
                    `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
                )}, { timeoutMs: 500 })`,
                sessionId: "s",
                cwd: process.cwd(),
            });
            await waitFor(() => backend.inspect(runId).run.status === "failed");
            expect(backend.inspect(runId).run.error).toContain("timed out");
            const pid = Number(await fs.promises.readFile(pidFile, "utf8"));
            let running = true;
            for (let attempt = 0; attempt < 50 && running; attempt++) {
                try {
                    process.kill(pid, 0);
                    await Bun.sleep(20);
                } catch {
                    running = false;
                }
            }
            expect(running).toBe(false);
        } finally {
            await backend.shutdown();
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });
    test("journals shell results and validates options before execution", async () => {
        let calls = 0;
        const backend = createWorkflowBackend({
            agentExecutor: async () => ({ value: null }),
            shellExecutor: async ({ command, cwd, env, timeoutMs }) => {
                calls++;
                expect({ command, cwd, env, timeoutMs }).toEqual({
                    command: "verify",
                    cwd: process.cwd(),
                    env: { MODE: "test" },
                    timeoutMs: 250,
                });
                return { exitCode: 7, stdout: "checked", stderr: "warning" };
            },
        });
        const launched = await backend.launch({
            name: "shell replay",
            script: `return await shell("verify", { timeoutMs: 250, env: { MODE: "test" } })`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(launched.runId).run.status === "succeeded");
        const retried = await backend.control(launched.runId, "retry");
        await waitFor(() => Boolean(retried?.runId && backend.inspect(retried.runId).run.status === "succeeded"));
        expect(calls).toBe(1);

        const invalid = await backend.launch({
            name: "invalid shell",
            script: `await shell("verify", { env: { BAD: 1 } })`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(invalid.runId).run.status === "failed");
        expect(backend.inspect(invalid.runId).run.error).toContain("environment");
        expect(calls).toBe(1);
        await backend.shutdown();
    });
    test("executes an exported workflow function with explicit frozen context and args", async () => {
        const source = `import type { WorkflowContext } from "pui/workflow";
export const meta = { name: "function-workflow", description: "Function workflow" };
type Args = { topic: string };
export default async function workflow(context: WorkflowContext, args: Args) {
    const ambient = [typeof agent, typeof shell, typeof phase, typeof pipeline, typeof parallel, typeof log, typeof globalThis.args];
    const result = await context.agent(\`Review \${args.topic}\`, { role: "explore" });
    const command = await context.shell("check", { timeoutMs: 123, env: { TOPIC: args.topic } });
    return { result, command, frozen: Object.isFrozen(context), ambient };
}`;
        const backend = createWorkflowBackend({
            agentExecutor: async ({ prompt }) => ({ value: prompt.toUpperCase() }),
            shellExecutor: async ({ command, timeoutMs, env }) => ({
                exitCode: 0,
                stdout: `${command}:${timeoutMs}:${env?.TOPIC}`,
                stderr: "",
            }),
        });
        const { runId } = await backend.launch({
            name: "function-workflow",
            script: source,
            entrypoint: "function",
            args: { topic: "api" },
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({
            result: "REVIEW API",
            command: { exitCode: 0, stdout: "check:123:api", stderr: "" },
            frozen: true,
            ambient: ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined"],
        });
        expect(backend.inspect(runId).script).toBe(source);
        await backend.shutdown();
    });
    test("executes erasable TypeScript syntax in strip-only mode", async () => {
        const source = `interface Item { value: number }
type Result<T> = { item: T };
const identity = <T,>(value: T): T => value;
const item: Item = { value: identity<number>(3) };
const result = { item } satisfies Result<Item>;
return result;`;
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
        const { runId } = await backend.launch({
            name: "typescript",
            script: source,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({ item: { value: 3 } });
        expect(backend.inspect(runId).script).toBe(source);
        await backend.shutdown();
    });
    test("accepts type-only namespaces in strip-only mode", () => {
        const body = `namespace TypeOnly { export type A = string; }\nconst value: TypeOnly.A = "ok";\nreturn value;`;
        expect(() => preflightWorkflow(body)).not.toThrow();
        expect(() =>
            preflightWorkflow(`export default async function workflow() { ${body} }`, "function"),
        ).not.toThrow();
    });
    test("rejects unsupported TypeScript during preflight", async () => {
        const scripts = [
                `enum Direction { fetch, Right }\nreturn Direction.fetch;`,
                `class Item { constructor(public value: number) {} }\nreturn new Item(1);`,
                `namespace Items { export const value = 1 }\nreturn Items.value;`,
                `@sealed class Item {}\nreturn new Item();`,
                `class Service { constructor(@Inject private value: Value) {} }`,
            ],
            backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
        for (const script of scripts) expect(() => preflightWorkflow(script)).toThrow("unsupported in strip-only mode");
        await expect(
            backend.launch({ name: "unsupported typescript", script: scripts[1]!, sessionId: "s", cwd: process.cwd() }),
        ).rejects.toThrow("unsupported in strip-only mode");
        await backend.shutdown();
    });
    test("accepts unsupported TypeScript keywords inside regex literals", () => {
        expect(() => preflightWorkflow(`return /enum Direction/.test("enum Direction");`)).not.toThrow();
    });
    test("executes JavaScript metadata source unchanged and retains exact source bytes", async () => {
        const source = `export const meta = {
    name: "review",
    description: "Review changed files",
};
await phase("Review");
return { ok: true, args };\n`;
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: null }) });
        const { runId } = await backend.launch({
            name: "review",
            script: source,
            args: { exact: true },
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({ ok: true, args: { exact: true } });
        expect(backend.inspect(runId).script).toBe(source);
        await backend.shutdown();
    });
    test("keeps typed VM values, constructors, and RPC results in-realm without ambient authority", async () => {
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: { safe: true } }) });
        const { runId } = await backend.launch({
            name: "adversarial",
            script: `interface Safe { safe: boolean } type Probe = unknown; const result: Safe=await agent("safe"); const probes: Probe[]=[agent,phase,log,pipeline,parallel,result,args]; const escaped: unknown[]=[]; for(const value of probes){try{escaped.push((value as any).constructor("return pro"+"cess")())}catch(e){escaped.push(null)}} let dynamic: boolean=false; try{({}).constructor.constructor("return pro"+"cess")()}catch(e){dynamic=true} return {escaped:escaped.every(x=>x===null),dynamic,globals:[globalThis["pro"+"cess"],globalThis["req"+"uire"],globalThis["fet"+"ch"],globalThis["Web"+"Socket"]].every(x=>x===undefined),builtin:typeof globalThis["pro"+"cess"]?.getBuiltinModule,kill:typeof globalThis["pro"+"cess"]?.kill};`,
            args: {},
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({
            escaped: true,
            dynamic: true,
            globals: true,
            builtin: "undefined",
            kill: "undefined",
        });
        await backend.shutdown();
    });
    test("keeps agent rejection reasons primitive and unable to escape their realm", async () => {
        const backend = createWorkflowBackend({
            agentExecutor: async () => {
                throw new Error("deliberate");
            },
        });
        const { runId } = await backend.launch({
            name: "rejection",
            script: `let reason; try{await agent("fail")}catch(e){reason={type:typeof e,escaped:false};try{e.constructor.constructor("return pro"+"cess")();reason.escaped=true}catch{}} return reason`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(runId).run.status === "succeeded");
        expect(JSON.parse(backend.inspect(runId).result!)).toEqual({ type: "string", escaped: false });
        await backend.shutdown();
    });
    test("rejects bounded agent options before executor and always publishes valid summaries", async () => {
        let called = false;
        const backend = createWorkflowBackend({
            policy: { roles: ["generic"], models: ["known"] },
            agentExecutor: async () => {
                called = true;
                return { value: null };
            },
        });
        for (const options of [
            `{label:"x".repeat(513)}`,
            `{role:"x".repeat(129)}`,
            `{model:"x".repeat(257)}`,
            `{retries:1.5}`,
            `{timeoutMs:Infinity}`,
            `{isolation:"container"}`,
            `{unknown:true}`,
            `{schema:{x:${"{x:".repeat(18)}1${"}".repeat(18)}}}`,
        ]) {
            const { runId } = await backend.launch({
                name: "invalid",
                script: `await agent("safe",${options})`,
                sessionId: "s",
                cwd: process.cwd(),
            });
            await waitFor(() => backend.inspect(runId).run.status === "failed");
            expect(parseWorkflowRunV1(backend.inspect(runId).run)).toBeDefined();
        }
        expect(called).toBe(false);
        await backend.shutdown();
    });
    test("aborting more than four queued agents removes the queue without starting executors", async () => {
        let started = 0;
        const backend = createWorkflowBackend({
            agentExecutor: (request) => {
                started++;
                return new Promise((_resolve, reject) =>
                    request.signal.addEventListener("abort", () => reject("abort"), { once: true }),
                );
            },
        });
        const run = await backend.launch({
            name: "queue",
            script: `await parallel(Array.from({length:12},(_,i)=>agent(String(i))))`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => started === 4);
        await backend.control(run.runId, "stop");
        await backend.shutdown();
        expect(started).toBe(4);
        expect(backend.inspect(run.runId).run.status).toBe("cancelled");
    });
    test("immediate stop after launch cancels promptly", async () => {
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: "unexpected" }) });
        const run = await backend.launch({
            name: "stop",
            script: `await agent("x")`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await backend.control(run.runId, "stop");
        await Promise.race([
            backend.shutdown(),
            Bun.sleep(2_000).then(() => {
                throw new Error("shutdown hung");
            }),
        ]);
        expect(backend.inspect(run.runId).run.status).toBe("cancelled");
    });
    test("globally caps parallel agents, enforces ignored-signal timeout, policy, and terminal state", async () => {
        let active = 0,
            peak = 0;
        const backend = createWorkflowBackend({
            policy: { roles: ["generic"], models: ["allowed"] },
            agentExecutor: async (request) => {
                active++;
                peak = Math.max(peak, active);
                try {
                    if (request.prompt === "hang") return await new Promise(() => {});
                    await Bun.sleep(30);
                    return { value: request.prompt, usage: { input: 1, totalTokens: 1 } };
                } finally {
                    active--;
                }
            },
        });
        const parallel = await backend.launch({
            name: "parallel",
            script: `return await parallel(Array.from({length:8},(_,i)=>agent(String(i),{model:"allowed"})))`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(parallel.runId).run.status === "succeeded");
        expect(peak).toBe(4);
        const denied = await backend.launch({
            name: "denied",
            script: `await agent("x",{role:"admin"})`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(denied.runId).run.status === "failed");
        expect(backend.inspect(denied.runId).run.error).toContain("host policy");
        const timed = await backend.launch({
            name: "timed",
            script: `await agent("hang",{model:"allowed",timeoutMs:20})`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.inspect(timed.runId).run.status === "failed");
        expect(backend.inspect(timed.runId).run.agents[0]?.status).toBe("timed_out");
        // An injected executor that ignores abort is intentionally not awaited; host timeout must stay bounded.
        await backend.control(timed.runId, "stop");
        await backend.shutdown();
    });
    test("shutdown waits for cooperative executor cleanup", async () => {
        let cleaned = false;
        const backend = createWorkflowBackend({
            cooperativeExecutor: true,
            agentExecutor: (request) =>
                new Promise((_resolve, reject) =>
                    request.signal.addEventListener(
                        "abort",
                        () => {
                            setTimeout(() => {
                                cleaned = true;
                                reject(new Error("cleaned"));
                            }, 30);
                        },
                        { once: true },
                    ),
                ),
        });
        await backend.launch({ name: "cleanup", script: `await agent("wait")`, sessionId: "s", cwd: process.cwd() });
        await waitFor(() => backend.list()[0]?.agents.length === 1);
        await backend.shutdown();
        expect(cleaned).toBe(true);
    });
    test("user cancellation is terminal while shutdown interruption remains recoverable", async () => {
        let aborted = 0;
        const backend = createWorkflowBackend({
            agentExecutor: (request) =>
                new Promise((_resolve, reject) =>
                    request.signal.addEventListener(
                        "abort",
                        () => {
                            aborted++;
                            reject(new Error("aborted"));
                        },
                        { once: true },
                    ),
                ),
        });
        const one = await backend.launch({
            name: "one",
            script: `await agent("wait")`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        const two = await backend.launch({
            name: "two",
            script: `await agent("wait")`,
            sessionId: "s",
            cwd: process.cwd(),
        });
        await waitFor(() => backend.list().filter((r) => r.agents.length).length === 2);
        await backend.control(one.runId, "stop");
        await backend.shutdown();
        expect(aborted).toBe(2);
        expect(backend.inspect(one.runId).run.status).toBe("cancelled");
        expect(backend.inspect(two.runId).run.status).toBe("paused");
    });
});
