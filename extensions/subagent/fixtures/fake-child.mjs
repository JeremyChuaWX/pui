import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const scenario = process.argv[2] ?? "success";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const usage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};
const finalEvent = (text = "fixture output") =>
    `${JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "fixture",
            provider: "fixture",
            model: "fixture/model",
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
        },
    })}\n`;

if (scenario === "success") {
    const payload = readFileSync(new URL("./success.jsonl", import.meta.url));
    const cuts = [7, 41, 113, 251, 509, 997, payload.length];
    let offset = 0;
    for (const cut of cuts) {
        if (cut <= offset) continue;
        process.stdout.write(payload.subarray(offset, Math.min(cut, payload.length)));
        offset = cut;
        await sleep(8);
    }
} else if (scenario === "malformed-success") {
    process.stdout.write("not-json\n");
    process.stdout.write(finalEvent("recovered output"));
} else if (scenario === "no-final") {
    process.stdout.write(`${JSON.stringify({ type: "turn_start", turnIndex: 0 })}\n`);
} else if (scenario === "invalid-final") {
    process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } })}\n`);
} else if (scenario === "failure") {
    process.stderr.write("fixture child failed actionably\n");
    process.exitCode = 7;
} else if (scenario === "hang") {
    process.on("SIGTERM", () => {});
    process.stdout.write(`${JSON.stringify({ type: "turn_start", turnIndex: 0 })}\n`);
    setInterval(() => {}, 1000);
} else if (scenario === "descendant-hang") {
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
        stdio: "ignore",
    });
    process.stderr.write(`descendant:${descendant.pid}\n`);
    setInterval(() => {}, 1000);
} else if (scenario === "large-stderr-failure") {
    process.stderr.write("x".repeat(128 * 1024));
    process.exitCode = 2;
} else {
    process.stderr.write(`unknown fixture scenario: ${scenario}\n`);
    process.exitCode = 64;
}
