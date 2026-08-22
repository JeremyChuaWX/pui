import { describe, expect, test } from "bun:test";
import { createWorkflowBackend, type WorkflowBackendOptions } from "./backend.js";

const prelude = `const send=x=>process.stdout.write(typeof x==="string"?x:JSON.stringify(x)+"\\n");`;
const ready = `send({v:1,t:"ready"});`;

async function run(workerSource: string, options: Partial<WorkflowBackendOptions> = {}) {
    const platform = {
        workerSource: prelude + workerSource,
        readyTimeoutMs: 2_000,
        watchdogMs: 100,
        runTimeoutMs: 500,
        ...options.platform,
    };
    const backend = createWorkflowBackend({
        agentExecutor: async () => ({ value: null }),
        ...options,
        platform,
    });
    const { runId } = await backend.launch({
        name: "hostile transport",
        script: "return null",
        sessionId: "transport-test",
        cwd: process.cwd(),
    });
    // Poll past the slowest configured supervision limit plus scheduling and kill-escalation margin.
    const deadline = Date.now() + Math.max(platform.readyTimeoutMs, platform.watchdogMs, platform.runTimeoutMs) + 2_000;
    while (!(["failed", "cancelled", "succeeded"] as string[]).includes(backend.inspect(runId).run.status)) {
        if (Date.now() > deadline) throw new Error("hostile worker did not terminate");
        await Bun.sleep(10);
    }
    const details = backend.inspect(runId);
    await Promise.race([
        backend.shutdown(),
        Bun.sleep(1_000).then(() => {
            throw new Error("hostile worker was not reaped");
        }),
    ]);
    return { ...details.run, result: details.result };
}

// Frame-shape and line-cap rules are unit-tested in worker-protocol.test.ts; the tests here keep
// only the behaviors that need a real worker process: supervision, reaping, and sandbox limits.
describe("workflow hostile transport and watchdog", () => {
    test("fails and reaps a worker that violates the frame protocol", async () => {
        const result = await run(`send({v:2,t:"ready"});setInterval(()=>{},1000)`);
        expect(result.status).toBe("failed");
        expect(result.error?.length).toBeLessThanOrEqual(2_000);
    });

    test("accepts coalesced frames containing a terminal value at the JSON size limit", async () => {
        const result = await run(
            `const json=JSON.stringify("x".repeat(262142));process.stdout.write([JSON.stringify({v:1,t:"ready"}),JSON.stringify({v:1,t:"heartbeat"}),JSON.stringify({v:1,t:"terminal",ok:true,json})].join("\\n")+"\\n")`,
        );
        expect(Buffer.byteLength(JSON.stringify("x".repeat(262142)))).toBe(262144);
        expect(result.status).toBe("succeeded");
        expect(result.result).toBe(JSON.stringify("x".repeat(262142)));
    });

    test("rejects a terminal frame while an agent RPC is pending and aborts the executor", async () => {
        let aborted = false;
        const result = await run(
            `${ready}process.stdin.once("data",()=>{send({v:1,t:"rpc",id:"1",method:"agent",value:{prompt:"hang",options:{}},identity:"site#1"});send({v:1,t:"terminal",ok:true,json:"null"})});setInterval(()=>send({v:1,t:"heartbeat"}),25)`,
            {
                cooperativeExecutor: true,
                agentExecutor: ({ signal }) =>
                    new Promise((_resolve, reject) => {
                        const abort = () => {
                            aborted = true;
                            reject(new Error("aborted"));
                        };
                        if (signal.aborted) abort();
                        else signal.addEventListener("abort", abort, { once: true });
                    }),
            },
        );
        expect(result.status).toBe("failed");
        expect(result.error).toContain("pending RPC");
        expect(aborted).toBe(true);
    });

    test("rejects invalid terminal JSON", async () => {
        const result = await run(`${ready}process.stdin.once("data",()=>send({v:1,t:"terminal",ok:true,json:"{"}))`);
        expect(result.status).toBe("failed");
        expect(result.error).toContain("Malformed workflow result");
    });

    test("heartbeat kills a ready worker whose event loop hangs", async () => {
        const result = await run(`${ready}setTimeout(()=>{while(true){}},0)`, { platform: { runTimeoutMs: 1_500 } });
        expect(result.error).toContain("heartbeat timed out");
    });

    test("bounds stderr from a nonzero worker exit and reaps it", async () => {
        const result = await run(`process.stderr.write("E".repeat(20000)+" pid="+process.pid);process.exit(7)`);
        expect(result.status).toBe("failed");
        expect(result.error?.length).toBeLessThanOrEqual(2_000);
        expect(result.error).toContain("E".repeat(100));
    });

    test("does not grant injected workers write, network, or child-process permissions", async () => {
        const result = await run(
            `${ready}process.stdin.once("data",()=>{const scopes=["fs.write","net","child"];const granted=scopes.filter(x=>process.permission.has(x));send(granted.length?{v:1,t:"terminal",ok:true,json:JSON.stringify(granted)}:{v:1,t:"terminal",ok:false,error:"permissions denied"})})`,
        );
        expect(result.status).toBe("failed");
        expect(result.error).toBe("permissions denied");
    });

    test("supervises an async workflow that enters an infinite loop", async () => {
        const backend = createWorkflowBackend({
            agentExecutor: async () => ({ value: null }),
            platform: { watchdogMs: 100, runTimeoutMs: 500 },
        });
        const { runId } = await backend.launch({
            name: "async hang",
            script: "await Promise.resolve(); while(true){}",
            sessionId: "transport-test",
            cwd: process.cwd(),
        });
        const deadline = Date.now() + 2_000;
        while (backend.inspect(runId).run.status !== "failed") {
            if (Date.now() > deadline) throw new Error("workflow hang escaped supervision");
            await Bun.sleep(10);
        }
        expect(backend.inspect(runId).run.error).toMatch(/heartbeat|timed out/);
        await backend.shutdown();
    });

    test("retains the production 128 MiB heap cap under memory pressure", async () => {
        const result = await run(
            `${ready}const held=[];setImmediate(()=>{for(;;)held.push(new Array(100000).fill(Math.random()))});setInterval(()=>send({v:1,t:"heartbeat"}),25)`,
            { platform: { watchdogMs: 2_000, runTimeoutMs: 3_000 } },
        );
        expect(result.status).toBe("failed");
        // Depending on Node/OS reserve behavior, either V8's bounded OOM exit or total supervision wins.
        expect(result.error).toMatch(/heap|exited|timed out/i);
    }, 10_000);
});
