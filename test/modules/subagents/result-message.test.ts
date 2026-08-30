import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobResult } from "#modules/subagents/protocol.js";
import { prepareResultMessage } from "#modules/subagents/result-message.js";

const roots: string[] = [];

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-subagent-result-"));
    roots.push(root);
    return root;
}

function completed(text: string, overrides: Partial<JobResult> = {}): JobResult {
    const status = overrides.status ?? "completed";
    return {
        job: {
            id: "explorer_1",
            profile: "explorer",
            task: "inspect it",
            cwd: "/work",
            state: status,
            createdAt: 1,
            startedAt: 2,
            endedAt: 3,
        },
        status,
        text,
        partial: false,
        runtimeMs: 1_500,
        usage: { input: 1_000, output: 500, totalTokens: 1_500, cost: 0.01 },
        ...overrides,
    };
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("subagent result messages", () => {
    test("retains exact private output without overwriting an earlier Job id", () => {
        const dir = path.join(temporaryRoot(), "results");
        const first = prepareResultMessage(completed("first", { partial: true }), dir);
        const second = prepareResultMessage(completed("second"), dir);

        expect(path.basename(first.details.location)).toBe("explorer_1.md");
        expect(path.basename(second.details.location)).toBe("explorer_1-2.md");
        expect(fs.readFileSync(first.details.location, "utf8")).toBe("first");
        expect(fs.readFileSync(second.details.location, "utf8")).toBe("second");
        expect(fs.statSync(first.details.location).mode & 0o777).toBe(0o600);
        expect(first.content).toContain("completed in 2s, 2k tokens, partial output");
    });

    test("bounds a Unicode preview by UTF-8 bytes and retains the complete text", () => {
        const dir = path.join(temporaryRoot(), "results");
        const text = "😀".repeat(6_000);
        const prepared = prepareResultMessage(completed(text), dir);

        expect(Buffer.byteLength(prepared.details.preview, "utf8")).toBeLessThanOrEqual(16 * 1_024);
        expect(prepared.details.preview).toEndWith("\n\n[truncated; read the full output file]");
        expect(fs.readFileSync(prepared.details.location, "utf8")).toBe(text);
    });

    test("retains an error when there is no output and degrades on a storage failure", () => {
        const root = temporaryRoot();
        const failed = prepareResultMessage(
            completed("", { status: "failed", error: "model exploded", usage: undefined }),
            path.join(root, "results"),
        );
        expect(fs.readFileSync(failed.details.location, "utf8")).toBe("model exploded");
        expect(failed.content).toContain("Error: model exploded");

        const blocker = path.join(root, "blocker");
        fs.writeFileSync(blocker, "not a directory");
        const unwritten = prepareResultMessage(completed("output"), path.join(blocker, "child"));
        expect(unwritten.details.location).toStartWith("not written (");
        expect(unwritten.content).toContain("Full output: not written (");
    });
});
