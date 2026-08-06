import { describe, expect, test } from "bun:test";
import { BoundedProcessError, runBoundedProcess } from "./bounded-process.js";
import {
    appendBoundedUtf8,
    formatTruncationNotice,
    type RetainedOutputFileSystem,
    RetainedOutputStore,
    truncateUtf8,
    truncateUtf8Tail,
} from "./retained-output.js";

describe("retained-output presentation", () => {
    test("single-sources code-point-safe head, tail, and append truncation", () => {
        expect(truncateUtf8("A界B", 4).content).toBe("A界");
        expect(truncateUtf8Tail("A界B", 4).content).toBe("界B");
        expect(appendBoundedUtf8("A界", "B", 4)).toBe("界B");
    });

    test("formats retained and explicitly non-retained bounded notices", () => {
        expect(formatTruncationNotice({ outputBytes: 4, totalBytes: 9, retainedPath: "/tmp/result" })).toBe(
            '[Output truncated: 4 of 9 bytes. Complete output retained at: "/tmp/result".]',
        );
        const bounded = formatTruncationNotice({
            outputBytes: 1,
            totalBytes: 9,
            nonRetentionReason: "storage failed 界",
            maxBytes: 72,
        });
        expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(72);
        expect(bounded).not.toContain("�");
    });

    test("keeps the closing bracket and the retained path's tail under a tight bound", () => {
        const bounded = formatTruncationNotice({
            outputBytes: 4,
            totalBytes: 9,
            retainedPath: "/tmp/retained-outputs/very-long-directory-name/result.md",
            maxBytes: 100,
        });
        expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(100);
        expect(bounded.endsWith('".]')).toBe(true);
        expect(bounded).toContain("result.md");
    });
});

describe("runBoundedProcess", () => {
    test("captures output and exit status", async () => {
        const result = await runBoundedProcess({
            command: process.execPath,
            args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
            timeoutMs: 30_000,
            output: { maxBytes: 100, overflow: "fail" },
        });
        expect(result).toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
    });

    test("rejects output overflow", async () => {
        const promise = runBoundedProcess({
            command: process.execPath,
            args: ["-e", "process.stdout.write('too much')"],
            timeoutMs: 30_000,
            output: { maxBytes: 3, overflow: "fail" },
        });
        await expect(promise).rejects.toBeInstanceOf(BoundedProcessError);
        await expect(promise).rejects.toMatchObject({ reason: "output" });
    });

    test("rejects a slow child with the timeout reason", async () => {
        const promise = runBoundedProcess({
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 30_000)"],
            timeoutMs: 250,
            output: { maxBytes: 100, overflow: "fail" },
        });
        await expect(promise).rejects.toBeInstanceOf(BoundedProcessError);
        await expect(promise).rejects.toMatchObject({ reason: "timeout" });
    });
});

describe("RetainedOutputStore", () => {
    test("enforces quotas and cleans retained directories", async () => {
        const removed: string[] = [];
        const fs: RetainedOutputFileSystem = {
            async mkdtemp(prefix) {
                return `${prefix}fixture`;
            },
            async chmod() {},
            async writeFile() {},
            async rm(path) {
                removed.push(path);
            },
        };
        const store = new RetainedOutputStore({
            prefix: "shared-test-",
            fileName: "output.txt",
            fileSystem: fs,
            maxResultBytes: 4,
            maxSessionBytes: 5,
        });
        expect(await store.save("large")).toEqual({ failure: "result-quota" });
        expect(await store.save("four")).toHaveProperty("path");
        expect(await store.save("xx")).toEqual({ failure: "session-quota" });
        expect(await store.cleanup()).toBe(true);
        expect(removed).toHaveLength(1);
        expect(await store.save("x")).toEqual({ failure: "closed" });
    });

    test("releases failed write reservations", async () => {
        const fs: RetainedOutputFileSystem = {
            async mkdtemp() {
                return "/tmp/shared-failure";
            },
            async chmod() {},
            async writeFile() {
                throw new Error("disk full");
            },
            async rm() {},
        };
        const store = new RetainedOutputStore({ prefix: "x", fileName: "x", fileSystem: fs, maxSessionBytes: 3 });
        expect(await store.save("abc")).toEqual({ failure: "storage" });
        expect(await store.save("abc")).toEqual({ failure: "storage" });
    });
});
