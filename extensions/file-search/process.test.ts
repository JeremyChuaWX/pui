import { afterEach, describe, expect, test } from "bun:test";
import { access, readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { FileSearchOutput } from "./output.ts";
import { runFileSearch } from "./process.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-search.mjs", import.meta.url));
const cwd = path.dirname(fixture);
const retained: string[] = [];
afterEach(async () =>
    Promise.all(retained.splice(0).map((item) => rm(path.dirname(item), { recursive: true, force: true }))),
);

function run(scenario: string, options: Partial<Parameters<typeof runFileSearch>[0]> = {}) {
    return runFileSearch({
        command: process.execPath,
        args: [fixture, scenario],
        cwd,
        timeoutMs: 2_000,
        killGraceMs: 20,
        ...options,
    });
}

describe("FileSearchOutput", () => {
    test("removes its private spill directory when output fits", async () => {
        const capture = await FileSearchOutput.create();
        const directory = capture.directory;
        await capture.write("ok\n");
        expect((await capture.finish()).fullOutputPath).toBeUndefined();
        await expect(access(directory)).rejects.toThrow();
    });
});

describe("runFileSearch", () => {
    test("streams normal output and counts records", async () => {
        const result = await run("small");
        expect(result).toMatchObject({ status: "succeeded", output: "one\ntwo\n", count: 2, truncated: false });
    });

    test("treats rg exit 1 with no stdout as no matches", async () => {
        const result = await run("no-match", { tool: "rg" });
        expect(result).toMatchObject({ status: "succeeded", exitCode: 1, output: "", count: 0 });
    });

    test("reports ordinary nonzero exits and bounds stderr to 64KB", async () => {
        const result = await run("stderr");
        expect(result.status).toBe("failed");
        expect(Buffer.byteLength(result.stderr)).toBe(64 * 1024);
    });

    test.each(["bytes", "lines"])("truncates %s output and retains the complete private spill", async (scenario) => {
        const result = await run(scenario);
        expect(result.truncated).toBe(true);
        expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
        expect(result.output.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES + 1);
        expect(result.fullOutputPath).toBeString();
        retained.push(result.fullOutputPath!);
        expect((await readFile(result.fullOutputPath!)).byteLength).toBe(result.totalBytes);
        if (process.platform !== "win32") {
            expect((await stat(path.dirname(result.fullOutputPath!))).mode & 0o777).toBe(0o700);
            expect((await stat(result.fullOutputPath!)).mode & 0o777).toBe(0o600);
        }
    });

    test("distinguishes timeout and cancellation", async () => {
        expect((await run("hang", { timeoutMs: 20 })).status).toBe("timed_out");
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        expect((await run("hang", { signal: controller.signal })).status).toBe("cancelled");
    });

    test.skipIf(process.platform === "win32")("kills descendants in the detached process group", async () => {
        const result = await run("descendant", { timeoutMs: 30 });
        const pid = Number(result.stderr.match(/descendant:(\d+)/)?.[1]);
        expect(pid).toBeGreaterThan(0);
        let alive = true;
        for (let attempt = 0; attempt < 50 && alive; attempt++) {
            try {
                process.kill(pid, 0);
                await Bun.sleep(10);
            } catch {
                alive = false;
            }
        }
        expect(alive).toBe(false);
    });
});
