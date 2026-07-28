import { describe, expect, test } from "bun:test";
import { createWorkflowBackend, type WorkflowBackendOptions } from "./backend.js";

const prelude = `const send=x=>process.stdout.write(typeof x==="string"?x:JSON.stringify(x)+"\\n");`;
const ready = `send({v:1,t:"ready"});`;

async function run(workerSource: string, options: Partial<WorkflowBackendOptions> = {}) {
    const backend = createWorkflowBackend({
        agentExecutor: async () => ({ value: null }),
        testOnlyWorkerSource: prelude + workerSource,
        readyTimeoutMs: 100,
        watchdogMs: 100,
        runTimeoutMs: 500,
        ...options,
    });
    const { runId } = await backend.launch({
        name: "hostile transport",
        script: "return null",
        sessionId: "transport-test",
        cwd: process.cwd(),
    });
    const deadline = Date.now() + 2_000;
    while (!(["failed", "cancelled", "succeeded"] as string[]).includes(backend.inspect(runId).run.status)) {
        if (Date.now() > deadline) throw new Error("hostile worker did not terminate");
        await Bun.sleep(10);
    }
    const result = backend.inspect(runId).run;
    await Promise.race([
        backend.shutdown(),
        Bun.sleep(1_000).then(() => {
            throw new Error("hostile worker was not reaped");
        }),
    ]);
    return result;
}

const failureCases = [
    ["malformed JSON", `send("not-json\\n");setInterval(()=>{},1000)`],
    ["unknown protocol version", `send({v:2,t:"ready"});setInterval(()=>{},1000)`],
    ["unknown protocol type", `send({v:1,t:"mystery"});setInterval(()=>{},1000)`],
    ["duplicate ready", `${ready}${ready}setInterval(()=>{},1000)`],
    ["extra ready fields", `send({v:1,t:"ready",extra:true});setInterval(()=>{},1000)`],
    ["unknown RPC method", `${ready}send({v:1,t:"rpc",id:"1",method:"root",value:null});setInterval(()=>{},1000)`],
    ["oversized unterminated frame", `process.stdout.write("x".repeat(262145));setInterval(()=>{},1000)`],
] as const;

describe("workflow hostile transport and watchdog", () => {
    for (const [name, source] of failureCases)
        test(name, async () => {
            const result = await run(source);
            expect(result.status).toBe("failed");
            expect(result.error?.length).toBeLessThanOrEqual(2_000);
        });

    test("caps concurrent pending RPC requests with a hanging executor", async () => {
        const requests = Array.from({ length: 17 }, (_, index) =>
            JSON.stringify({
                v: 1,
                t: "rpc",
                id: String(index),
                method: "agent",
                value: { prompt: "hang", options: {} },
                identity: `site#${index}`,
            }),
        ).join(",");
        const result = await run(
            `${ready}for(const x of [${requests}])send(x);setInterval(()=>send({v:1,t:"heartbeat"}),25)`,
            { agentExecutor: () => new Promise(() => {}) },
        );
        expect(result.status).toBe("failed");
    });

    test("heartbeat kills a ready worker whose event loop hangs", async () => {
        const result = await run(`${ready}setTimeout(()=>{while(true){}},0)`);
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
            watchdogMs: 100,
            runTimeoutMs: 500,
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
            { watchdogMs: 2_000, runTimeoutMs: 3_000 },
        );
        expect(result.status).toBe("failed");
        // Depending on Node/OS reserve behavior, either V8's bounded OOM exit or total supervision wins.
        expect(result.error).toMatch(/heap|exited|timed out/i);
    }, 5_000);
});
