import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerFileSearchExtension } from "./index.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-search.mjs", import.meta.url));
const fixtureCwd = path.dirname(fixture);

function setup(overrides: any = {}) {
    const tools = new Map<string, any>();
    registerFileSearchExtension(
        {
            registerTool(tool: any) {
                tools.set(tool.name, tool);
            },
            on() {},
        } as any,
        {
            resolveFd: () => ({ command: "/bin/fd", source: "system" }),
            resolveRg: () => ({ command: "/bin/rg", source: "system" }),
            run: async () => ({
                status: "succeeded",
                output: "a.ts\n",
                count: 1,
                totalBytes: 5,
                truncated: false,
                stderr: "",
                exitCode: 0,
                signal: null,
            }),
            ...overrides,
        },
    );
    return { tools };
}

function execute(tool: any, params: any, signal?: AbortSignal) {
    return tool.execute("call", params, signal, undefined, { cwd: "/repo" });
}

describe("file-search extension", () => {
    test("registers fd and rg with direct safe runner arguments", async () => {
        const calls: any[] = [];
        const { tools } = setup({
            run: async (options: any) => {
                calls.push(options);
                return {
                    status: "succeeded",
                    output: "",
                    count: 0,
                    totalBytes: 0,
                    truncated: false,
                    stderr: "",
                    exitCode: 1,
                    signal: null,
                };
            },
        });
        expect([...tools.keys()]).toEqual(["fd", "rg"]);
        expect((await execute(tools.get("fd"), { pattern: "--help" })).content[0].text).toBe("No matches found.");
        expect((await execute(tools.get("rg"), { pattern: "--version", fixed_strings: true })).content[0].text).toBe(
            "No matches found.",
        );
        expect(calls[0]).toMatchObject({
            command: "/bin/fd",
            cwd: "/repo",
            args: ["--color=never", "--max-results", "1000", "--", "--help"],
        });
        expect(calls[1].args).toContain("--fixed-strings");
        expect(calls[1].args.slice(-2)).toEqual(["--", "--version"]);
    });

    test("surfaces missing binaries and actionable process statuses", async () => {
        const missing = setup({
            resolveFd: () => {
                throw new Error("Install fd and try again.");
            },
        });
        await expect(execute(missing.tools.get("fd"), {})).rejects.toThrow("Install fd");
        const spawned = setup({
            resolveRg: () => ({ command: path.join(fixtureCwd, "missing-rg"), source: "system" }),
            run: undefined,
        });
        await expect(execute(spawned.tools.get("rg"), { pattern: "x" })).rejects.toThrow(
            /ENOENT.*missing-rg|missing-rg.*ENOENT/,
        );
        for (const [status, message] of [
            ["timed_out", "narrow the path"],
            ["cancelled", "cancelled"],
            ["failed", "permission denied"],
        ] as const) {
            const { tools } = setup({
                run: async () => ({
                    status,
                    output: "",
                    count: 0,
                    totalBytes: 0,
                    truncated: false,
                    stderr: status === "failed" ? "permission denied" : "",
                    exitCode: 2,
                    signal: null,
                }),
            });
            await expect(execute(tools.get("rg"), { pattern: "x" })).rejects.toThrow(message);
        }
    });

    test("returns renderer-neutral details, truncation path, and prompt guidance", async () => {
        const { tools } = setup({
            run: async () => ({
                status: "succeeded",
                output: "head",
                count: 2001,
                totalBytes: 60000,
                truncated: true,
                fullOutputPath: "/private/output.txt",
                stderr: "",
                exitCode: 0,
                signal: null,
            }),
        });
        const value = await execute(tools.get("rg"), { pattern: "x" });
        expect(value.details).toEqual({
            binarySource: "system",
            count: 2001,
            truncated: true,
            fullOutputPath: "/private/output.txt",
        });
        expect(value.content[0].text).toContain("Complete output: /private/output.txt");
        const prompt = [
            tools.get("fd").promptSnippet,
            ...tools.get("fd").promptGuidelines,
            tools.get("rg").promptSnippet,
            ...tools.get("rg").promptGuidelines,
        ].join("\n");
        expect(prompt).toContain("fd");
        expect(prompt).toContain("rg");
        expect(prompt).toContain("fixed_strings");
        expect(prompt).toContain("bash");
    });
});
