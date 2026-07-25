import { spawn } from "node:child_process";

const scenario = process.argv[2];
if (scenario === "small") process.stdout.write("one\ntwo\n");
else if (scenario === "no-match") process.exitCode = 1;
else if (scenario === "failure") {
    process.stderr.write("search failed");
    process.exitCode = 2;
} else if (scenario === "stderr") {
    process.stderr.write("x".repeat(100 * 1024));
    process.exitCode = 2;
} else if (scenario === "bytes") process.stdout.write("x".repeat(60 * 1024));
else if (scenario === "lines") process.stdout.write("x\n".repeat(2100));
else if (scenario === "hang") setInterval(() => {}, 1000);
else if (scenario === "descendant") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stderr.write(`descendant:${child.pid}\n`);
    setInterval(() => {}, 1000);
}
