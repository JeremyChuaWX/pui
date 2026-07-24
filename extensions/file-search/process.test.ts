import { afterEach, describe, expect, test } from "bun:test";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function spillDirectories() {
    return new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("pui-file-search-")));
}

async function expectDescendantStopped(pid: number) {
    expect(pid).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            process.kill(pid, 0);
            await Bun.sleep(10);
        } catch {
            return;
        }
    }
    throw new Error(`descendant ${pid} remained alive`);
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

    test.each([
        ["missing executable", { command: path.join(cwd, "definitely-missing-search-command") }, "ENOENT"],
        ["invalid cwd", { cwd: path.join(cwd, "definitely-missing-directory") }, "ENOENT"],
    ] as const)("preserves the underlying spawn error and cleans its spill for %s", async (_name, options, code) => {
        const before = await spillDirectories();
        let error: NodeJS.ErrnoException | undefined;
        try {
            await run("small", options);
        } catch (value) {
            error = value as NodeJS.ErrnoException;
        }
        expect(error?.code).toBe(code);
        expect(error?.message).toContain(code);
        expect(error?.message).not.toContain("Premature close");
        expect(await spillDirectories()).toEqual(before);
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

    test.skipIf(process.platform === "win32")(
        "kills descendants in the detached process group on timeout",
        async () => {
            const result = await run("descendant", { timeoutMs: 30 });
            expect(result.status).toBe("timed_out");
            await expectDescendantStopped(Number(result.stderr.match(/descendant:(\d+)/)?.[1]));
        },
    );

    test.skipIf(process.platform === "win32")(
        "kills descendants in the detached process group on cancellation",
        async () => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 30);
            const result = await run("descendant", { signal: controller.signal });
            expect(result.status).toBe("cancelled");
            await expectDescendantStopped(Number(result.stderr.match(/descendant:(\d+)/)?.[1]));
        },
    );
});
