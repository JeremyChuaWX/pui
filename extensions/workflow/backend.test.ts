import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowBackendOptions } from "./backend.js";
import { createWorkflowBackend as createBackend, preflightWorkflow, resolveWorkflowNode } from "./backend.js";
import { parseWorkflowRunV1 } from "./protocol.js";

// Legacy backend fixtures intentionally exercise the unsafe shared-checkout mode.
const createWorkflowBackend = (options: WorkflowBackendOptions) =>
    createBackend({ ...options, policy: { allowUnsafeSharedCheckout: true, ...options.policy } });

async function waitFor(predicate: () => boolean, timeout = 5_000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > end) throw new Error("timeout");
        await Bun.sleep(10);
    }
}

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
        expect(preflightWorkflow("phase('one'); for(let i=0;i<2;i++) await agent(String(i))")).toEqual({
            phases: ["one"],
            agents: 1,
        });
    });
    test("preflight ignores inert capability words but scans template expressions", () => {
        const script = `// process require import Function child_process\nlog("process import Function"); log(\`child_process ${"text"}\`)`;
        expect(preflightWorkflow(script).agents).toBe(0);
        expect(() => preflightWorkflow("log(`ordinary $" + "{globalThis['pro'+'cess']}`)")).not.toThrow();
        expect(() => preflightWorkflow("log(`ordinary $" + "{process.env}`)")).toThrow("forbidden");
        expect(() => preflightWorkflow("/* Function */ import('fs')")).toThrow("forbidden");
    });
    test("reports missing and old external Node actionably", async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-node-"));
        const old = path.join(dir, "node");
        await fs.promises.writeFile(old, "#!/bin/sh\necho v20.0.0\n", { mode: 0o755 });
        try {
            await expect(
                resolveWorkflowNode({
                    environment: { PUI_WORKFLOW_NODE: old, PATH: "" },
                    configuredPath: "/missing-node",
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
    test("executes the documented multiline saved definition and retains exact source bytes", async () => {
        const source = `export const meta = {
    name: "review",
    description: "Review changed files",
};
phase("Review");
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
    test("keeps VM constructors and RPC results in-realm without ambient authority", async () => {
        const backend = createWorkflowBackend({ agentExecutor: async () => ({ value: { safe: true } }) });
        const { runId } = await backend.launch({
            name: "adversarial",
            script: `const result=await agent("safe"); const probes=[agent,phase,log,pipeline,parallel,result,args]; const escaped=[]; for(const value of probes){try{escaped.push(value.constructor("return pro"+"cess")())}catch(e){escaped.push(null)}} let dynamic=false; try{({}).constructor.constructor("return pro"+"cess")()}catch(e){dynamic=true} return {escaped:escaped.every(x=>x===null),dynamic,globals:[globalThis["pro"+"cess"],globalThis["req"+"uire"],globalThis["fet"+"ch"],globalThis["Web"+"Socket"]].every(x=>x===undefined),builtin:typeof globalThis["pro"+"cess"]?.getBuiltinModule,kill:typeof globalThis["pro"+"cess"]?.kill};`,
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
