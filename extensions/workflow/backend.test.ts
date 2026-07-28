import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowBackend, preflightWorkflow, resolveWorkflowNode } from "./backend.js";

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
    test("cancellation aborts active executors and shutdown tracks every run", async () => {
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
        expect(backend.list().every((r) => ["cancelled", "failed"].includes(r.status))).toBe(true);
    });
});
