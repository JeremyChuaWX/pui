import { describe, expect, test } from "bun:test";
import { BoundedProcessError, runBoundedProcess } from "#modules/file-search/bounded-process.js";
import {
    appendBoundedUtf8,
    composeBoundedOutput,
    formatTruncationNotice,
    type RetainedOutputFileSystem,
    RetainedOutputStore,
    truncateUtf8,
    truncateUtf8Tail,
} from "#shared/lib/retained-output.js";

describe("retained-output presentation", () => {
    test("single-sources code-point-safe head, tail, and append truncation", () => {
        expect(truncateUtf8("A界B", 4).content).toBe("A界");
        expect(truncateUtf8Tail("A界B", 4).content).toBe("界B");
        expect(appendBoundedUtf8("A界", "B", 4)).toBe("界B");

        const text = "A😀界B";
        expect(Buffer.byteLength(text, "utf8")).toBe(9);
        expect(truncateUtf8(text, 5)).toEqual({
            content: "A😀",
            truncated: true,
            outputBytes: 5,
            totalBytes: 9,
        });
        expect(truncateUtf8(text, 4).content).toBe("A");
        expect(truncateUtf8Tail(text, 5).content).toBe("界B");
        expect(appendBoundedUtf8("old-", "😀new", 7)).toBe("😀new");
        expect(truncateUtf8(text, 9).truncated).toBe(false);
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

describe("composeBoundedOutput", () => {
    test("line-aware notices describe exactly the emitted preview", () => {
        const fullText = "content\n".repeat(100);
        const text = composeBoundedOutput(
            fullText,
            { maxBytes: 10_000, maxLines: 5 },
            { retainedPath: "/tmp/result.md" },
        );
        const [preview, notice] = text.split("\n\n");
        expect(preview).toBe("content\ncontent\ncontent");
        const counts = notice!.match(/^\[Output truncated: (\d+) of 800 bytes, (\d+) of 100 lines\./);
        expect(counts).not.toBeNull();
        expect(Number(counts![1])).toBe(Buffer.byteLength(preview!, "utf8"));
        expect(Number(counts![2])).toBe(3);
        expect(notice).toContain('retained at: "/tmp/result.md"');
    });

    test("keeps the whole composition within the byte budget as the notice grows", () => {
        for (let maxBytes = 1; maxBytes <= 200; maxBytes++) {
            const text = composeBoundedOutput(
                "π界\n".repeat(400),
                { maxBytes, maxLines: 6 },
                { nonRetentionReason: "retention was unavailable" },
            );
            expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(maxBytes);
            expect(text).not.toContain("�");
        }
    });

    test("returns only a bounded notice when lines cannot fit a preview plus separator", () => {
        const text = composeBoundedOutput(
            "wide output",
            { maxBytes: 30, maxLines: 2 },
            { totalBytes: 5_000, retainedPath: "/tmp/result.md" },
        );
        expect(text).toBe(
            truncateUtf8(
                '[Output truncated: 0 of 5000 bytes, 0 of 1 lines. Complete output retained at: "/tmp/result.md".]',
                30,
            ).content,
        );
        expect(text).not.toContain("\n");
    });

    test("byte-only mode omits line counts and honors total overrides", () => {
        const text = composeBoundedOutput(
            "abcdefghij".repeat(50),
            { maxBytes: 200 },
            { totalBytes: 9_999, nonRetentionReason: "the producer kept no copy" },
        );
        const notice = text.split("\n\n").at(-1);
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(200);
        expect(notice).toMatch(/^\[Output truncated: \d+ of 9999 bytes\./);
        expect(notice).not.toContain("lines");
        expect(notice).toContain("the producer kept no copy");
    });

    test("byte-only mode drops the separator when the budget only fits the notice", () => {
        const notice = formatTruncationNotice({ outputBytes: 0, totalBytes: 300, retainedPath: "/tmp/out" });
        const text = composeBoundedOutput(
            "z".repeat(300),
            { maxBytes: Buffer.byteLength(notice, "utf8") },
            { retainedPath: "/tmp/out" },
        );
        expect(text).toBe(notice);
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
