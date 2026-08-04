import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { WebOutputRetention, type WebOutputRetentionFileSystem } from "./output-retention.ts";
import { waitUntil } from "./test-utils.ts";

const stores: WebOutputRetention[] = [];

function store(dependencies: ConstructorParameters<typeof WebOutputRetention>[0] = {}): WebOutputRetention {
    const retention = new WebOutputRetention(dependencies);
    stores.push(retention);
    return retention;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

function fakeFileSystem(overrides: Partial<WebOutputRetentionFileSystem> = {}) {
    const calls = {
        mkdtemp: [] as string[],
        chmod: [] as Array<{ path: string; mode: number }>,
        writeFile: [] as Array<{ path: string; data: string; mode: number }>,
        rm: [] as string[],
    };
    let nextDirectory = 0;
    const fileSystem: WebOutputRetentionFileSystem = {
        async mkdtemp(prefix) {
            calls.mkdtemp.push(prefix);
            return `/private/web-output-${++nextDirectory}`;
        },
        async chmod(path, mode) {
            calls.chmod.push({ path, mode });
        },
        async writeFile(path, data, options) {
            calls.writeFile.push({ path, data, mode: options.mode });
        },
        async rm(path) {
            calls.rm.push(path);
        },
        ...overrides,
    };
    return { calls, fileSystem };
}

afterEach(async () => {
    await Promise.allSettled(stores.splice(0).map((retention) => retention.cleanup()));
});

describe("WebOutputRetention", () => {
    test("returns fitting output unchanged without filesystem work", async () => {
        const { calls, fileSystem } = fakeFileSystem();
        const retention = store({ fileSystem });

        expect(await retention.retain("small result", { maxBytes: 100, maxLines: 10 })).toEqual({
            text: "small result",
            truncated: false,
        });
        expect(calls.mkdtemp).toEqual([]);
        expect(calls.writeFile).toEqual([]);
    });

    test("stores the exact complete oversized output", async () => {
        const retention = store();
        const fullText = `Heading\n\n${"complete π output\n".repeat(20)}`;
        const result = await retention.retain(fullText, { maxBytes: 100, maxLines: 10 });

        expect(result.truncated).toBe(true);
        expect(result.fullOutputPath).toEndWith("result.md");
        expect(await readFile(result.fullOutputPath!, "utf8")).toBe(fullText);
    });

    test("creates private directories and files on POSIX", async () => {
        if (process.platform === "win32") return;
        const retention = store();
        const result = await retention.retain("private\n".repeat(30), { maxBytes: 40, maxLines: 5 });

        expect((await stat(dirname(result.fullOutputPath!))).mode & 0o777).toBe(0o700);
        expect((await stat(result.fullOutputPath!)).mode & 0o777).toBe(0o600);
    });

    test("bounds the preview, separator, notice, and retained path by UTF-8 bytes", async () => {
        const retention = store();
        const result = await retention.retain("π content\n".repeat(100), { maxBytes: 240, maxLines: 100 });

        expect(result.fullOutputPath).toBeString();
        expect(result.text).toContain("Output truncated");
        expect(result.text).toContain(result.fullOutputPath!);
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(240);
    });

    test("bounds the complete returned text by lines", async () => {
        const retention = store();
        const result = await retention.retain("content\n".repeat(100), { maxBytes: 10_000, maxLines: 5 });

        expect(result.text).toContain("\n\n[Output truncated");
        expect(result.text.split("\n")).toHaveLength(5);
    });

    test("keeps tiny results bounded and carries a retained path in details", async () => {
        const retention = store();
        const result = await retention.retain("large output!", { maxBytes: 12, maxLines: 1 });

        expect(result.truncated).toBe(true);
        expect(result.fullOutputPath).toEndWith("result.md");
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(12);
        expect(result.text).not.toContain("\n");
    });

    test("never splits UTF-8 while truncating a notice containing a multibyte path", async () => {
        let directory = 0;
        const { fileSystem } = fakeFileSystem({
            async mkdtemp() {
                return `/private/π-output-${++directory}`;
            },
        });
        const retention = store({ fileSystem });

        for (let maxBytes = 1; maxBytes <= 180; maxBytes++) {
            const result = await retention.retain("x".repeat(500), { maxBytes, maxLines: 1 });
            expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(maxBytes);
            expect(result.text).not.toContain("�");
        }
    });

    test("returns only the notice when its byte budget leaves no room for a preview separator", async () => {
        const { fileSystem } = fakeFileSystem();
        const retention = store({ fileSystem });
        const fullText = "x".repeat(2_000);
        const baseline = await retention.retain(fullText, { maxBytes: 1_000, maxLines: 10 });
        const notice = baseline.text.split("\n\n").at(-1)!.replace("web-output-1", "web-output-2");

        const result = await retention.retain(fullText, {
            maxBytes: Buffer.byteLength(notice, "utf8"),
            maxLines: 3,
        });

        expect(result.text).toBe(notice);
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(notice, "utf8"));
    });

    test("does not retain a result above the per-result quota", async () => {
        const { calls, fileSystem } = fakeFileSystem();
        const retention = store({ fileSystem, maxRetainedResultBytes: 20, maxRetainedSessionBytes: 1_000 });
        const result = await retention.retain("x".repeat(500), { maxBytes: 200, maxLines: 10 });

        expect(result.truncated).toBe(true);
        expect(result.fullOutputPath).toBeUndefined();
        expect(result.text).toContain("was not retained");
        expect(result.text).toContain("per-result retention quota");
        expect(calls.mkdtemp).toEqual([]);
    });

    test("reserves quota before concurrent writes can oversubscribe the session", async () => {
        const writeGate = deferred();
        const { calls, fileSystem } = fakeFileSystem({
            async writeFile(path, data, options) {
                calls.writeFile.push({ path, data, mode: options.mode });
                await writeGate.promise;
            },
        });
        const retention = store({ fileSystem, maxRetainedResultBytes: 600, maxRetainedSessionBytes: 750 });
        const first = retention.retain("a".repeat(500), { maxBytes: 200, maxLines: 10 });
        const second = await retention.retain("b".repeat(500), { maxBytes: 200, maxLines: 10 });

        expect(second.fullOutputPath).toBeUndefined();
        expect(second.text).toContain("session retention quota");
        writeGate.resolve();
        expect((await first).fullOutputPath).toBeString();
        expect(calls.mkdtemp).toHaveLength(1);
        expect(calls.writeFile).toHaveLength(1);
    });

    test("degrades after a failed write and releases its reservation", async () => {
        let writes = 0;
        const { calls, fileSystem } = fakeFileSystem({
            async writeFile(path, data, options) {
                calls.writeFile.push({ path, data, mode: options.mode });
                if (writes++ === 0) throw new Error("disk unavailable");
            },
        });
        const retention = store({ fileSystem, maxRetainedResultBytes: 300, maxRetainedSessionBytes: 300 });
        const failed = await retention.retain("x".repeat(300), { maxBytes: 200, maxLines: 10 });
        const recovered = await retention.retain("y".repeat(300), { maxBytes: 200, maxLines: 10 });

        expect(failed.fullOutputPath).toBeUndefined();
        expect(failed.text).toContain("Complete output was not retained");
        expect(failed.text).toContain("temporary storage failed");
        expect(recovered.fullOutputPath).toBeString();
    });

    test("waits for an in-progress write during cleanup and removes its directory", async () => {
        const writeGate = deferred();
        const { calls, fileSystem } = fakeFileSystem({
            async writeFile(path, data, options) {
                calls.writeFile.push({ path, data, mode: options.mode });
                await writeGate.promise;
            },
        });
        const retention = store({ fileSystem });
        const retained = retention.retain("pending output", { maxBytes: 4, maxLines: 10 });
        await waitUntil(() => calls.writeFile.length === 1);

        let cleaned = false;
        const cleanup = retention.cleanup().then(() => {
            cleaned = true;
        });
        await Bun.sleep(1);
        expect(cleaned).toBe(false);
        writeGate.resolve();
        expect((await retained).fullOutputPath).toBeUndefined();
        await cleanup;
        expect(calls.rm).toContain("/private/web-output-1");
    });

    test("refuses retention requested after cleanup begins", async () => {
        const removeGate = deferred();
        const { calls, fileSystem } = fakeFileSystem({
            async rm(path) {
                calls.rm.push(path);
                await removeGate.promise;
            },
        });
        const retention = store({ fileSystem });
        expect(
            (await retention.retain("first output ".repeat(40), { maxBytes: 200, maxLines: 10 })).fullOutputPath,
        ).toBeString();
        const cleanup = retention.cleanup();
        const afterShutdown = await retention.retain("late output ".repeat(40), { maxBytes: 200, maxLines: 10 });

        expect(afterShutdown.fullOutputPath).toBeUndefined();
        expect(afterShutdown.text).toContain("session is shutting down");
        expect(calls.mkdtemp).toHaveLength(1);
        removeGate.resolve();
        await cleanup;
    });

    test("startSession reopens a cleaned-up owner for new retained results", async () => {
        const { calls, fileSystem } = fakeFileSystem();
        const retention = store({ fileSystem });
        await retention.retain("first session ".repeat(40), { maxBytes: 200, maxLines: 10 });
        await expect(retention.cleanup()).resolves.toBe(true);

        retention.startSession();
        const reopened = await retention.retain("second session ".repeat(40), { maxBytes: 200, maxLines: 10 });

        expect(reopened.fullOutputPath).toBeString();
        expect(calls.mkdtemp).toHaveLength(2);
        expect(calls.rm).toEqual(["/private/web-output-1"]);
    });

    test("startSession keeps directories whose removal failed so the next cleanup retries them", async () => {
        let removals = 0;
        const { calls, fileSystem } = fakeFileSystem({
            async rm(path) {
                calls.rm.push(path);
                if (removals++ === 0) throw new Error("busy");
            },
        });
        const retention = store({ fileSystem });
        await retention.retain("first session ".repeat(40), { maxBytes: 200, maxLines: 10 });
        await expect(retention.cleanup()).resolves.toBe(false);

        retention.startSession();
        await retention.retain("second session ".repeat(40), { maxBytes: 200, maxLines: 10 });
        await expect(retention.cleanup()).resolves.toBe(true);

        expect(calls.rm.filter((path) => path === "/private/web-output-1")).toHaveLength(2);
        expect(calls.rm).toContain("/private/web-output-2");
    });

    test("retries directories whose removal failed during cleanup", async () => {
        let removals = 0;
        const { calls, fileSystem } = fakeFileSystem({
            async rm(path) {
                calls.rm.push(path);
                if (removals++ === 0) throw new Error("busy");
            },
        });
        const retention = store({ fileSystem });
        await retention.retain("retained output", { maxBytes: 4, maxLines: 10 });

        const first = retention.cleanup();
        expect(retention.cleanup()).toBe(first);
        await expect(first).resolves.toBe(false);
        await expect(retention.cleanup()).resolves.toBe(true);
        await retention.cleanup();

        expect(calls.rm).toEqual(["/private/web-output-1", "/private/web-output-1"]);
    });

    test("cleanup is idempotent and swallows missing-file errors", async () => {
        const { calls, fileSystem } = fakeFileSystem({
            async rm(path) {
                calls.rm.push(path);
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
            },
        });
        const retention = store({ fileSystem });
        await retention.retain("retained output", { maxBytes: 4, maxLines: 10 });

        const first = retention.cleanup();
        const second = retention.cleanup();
        expect(second).toBe(first);
        await expect(first).resolves.toBe(true);
        expect(calls.rm).toEqual(["/private/web-output-1"]);
    });
});
