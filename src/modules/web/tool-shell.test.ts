import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { WebOutputRetention } from "./output-retention.ts";
import { executeWebTool } from "./tool-shell.ts";

const owners: WebOutputRetention[] = [];

function owner(options: ConstructorParameters<typeof WebOutputRetention>[0] = {}) {
    const retention = new WebOutputRetention(options);
    owners.push(retention);
    return retention;
}

function execute(outputRetention: WebOutputRetention, fullText: string, limits = { maxBytes: 100, maxLines: 10 }) {
    return executeWebTool({
        toolName: "web_test",
        cancelledMessage: "Cancelled.",
        outputRetention,
        signal: undefined,
        onUpdate: undefined,
        starting: { text: "Starting", details: { status: "starting" } },
        limits,
        async run() {
            return { fullText, details: { status: "complete" as const, metadata: "preserved" } };
        },
    });
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Expected text output");
    return content.text;
}

afterEach(async () => {
    await Promise.allSettled(owners.splice(0).map((retention) => retention.cleanup()));
});

describe("executeWebTool output retention", () => {
    test("returns fitting output and provider metadata unchanged", async () => {
        const result = await execute(owner(), "complete formatted output");

        expect(result.content).toEqual([{ type: "text", text: "complete formatted output" }]);
        expect(result.details).toEqual({ status: "complete", metadata: "preserved", truncated: false });
    });

    test("bounds oversized output and retains its exact complete text once for every provider", async () => {
        const fullText = `Heading\n${"complete π output\n".repeat(100)}`;
        const result = await execute(owner(), fullText, { maxBytes: 240, maxLines: 5 });

        expect(result.details.truncated).toBe(true);
        expect(result.details.fullOutputPath).toEndWith("result.md");
        expect(resultText(result)).toContain("Output truncated");
        expect(Buffer.byteLength(resultText(result), "utf8")).toBeLessThanOrEqual(240);
        expect(resultText(result).split("\n").length).toBeLessThanOrEqual(5);
        expect(await readFile(result.details.fullOutputPath!, "utf8")).toBe(fullText);
    });

    test("shares session quota across calls", async () => {
        const retention = owner({ maxRetainedResultBytes: 500, maxRetainedSessionBytes: 500 });
        const limits = { maxBytes: 300, maxLines: 10 };
        const first = await execute(retention, "a".repeat(500), limits);
        const second = await execute(retention, "b".repeat(500), limits);

        expect(first.details.fullOutputPath).toBeString();
        expect(second.details).toEqual({ status: "complete", metadata: "preserved", truncated: true });
        expect(resultText(second)).toContain("session retention quota");
    });

    test("cleans up a session and retains output again after the next session starts", async () => {
        const retention = owner();
        const first = await execute(retention, "first ".repeat(100));
        const second = await execute(retention, "second ".repeat(100));
        const paths = [first.details.fullOutputPath!, second.details.fullOutputPath!];

        for (const path of paths) expect(await stat(path)).toBeDefined();
        expect(dirname(paths[0])).not.toBe(dirname(paths[1]));
        await expect(retention.cleanup()).resolves.toBe(true);
        for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

        retention.startSession();
        const nextSession = await execute(retention, "next ".repeat(100));
        expect(nextSession.details.truncated).toBe(true);
        expect(nextSession.details.fullOutputPath).toBeString();
        expect(await stat(nextSession.details.fullOutputPath!)).toBeDefined();
    });
});
