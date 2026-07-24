import { describe, expect, test } from "bun:test";
import { buildFdArgs, buildRgArgs, normalizeSearchPath } from "./args.ts";

const home = "/home/tester";

describe("file-search argument builders", () => {
    test("builds fd defaults", () => {
        expect(buildFdArgs({}, home)).toEqual(["--color=never", "--max-results", "1000", "--", ""]);
    });

    test("builds every fd option and keeps a flag-like pattern positional", () => {
        expect(
            buildFdArgs(
                {
                    pattern: "--help",
                    path: "@~/src",
                    type: "symlink",
                    extension: "..ts",
                    glob: true,
                    hidden: true,
                    max_depth: 64,
                    limit: 10_000,
                },
                home,
            ),
        ).toEqual([
            "--color=never",
            "--max-results",
            "10000",
            "--type",
            "symlink",
            "--extension",
            "ts",
            "--glob",
            "--hidden",
            "--max-depth",
            "64",
            "--",
            "--help",
            "/home/tester/src",
        ]);
    });

    test("builds rg defaults", () => {
        expect(buildRgArgs({ pattern: "needle" }, home)).toEqual([
            "--line-number",
            "--color=never",
            "--no-heading",
            "--with-filename",
            "--smart-case",
            "--max-count",
            "100",
            "--",
            "needle",
        ]);
    });

    test("builds every rg option and keeps a flag-like pattern positional", () => {
        expect(
            buildRgArgs(
                {
                    pattern: "--version",
                    path: "@~",
                    glob: "*.ts",
                    file_type: "typescript",
                    case_sensitive: true,
                    fixed_strings: true,
                    hidden: true,
                    context: 20,
                    limit: 1000,
                },
                home,
            ),
        ).toEqual([
            "--line-number",
            "--color=never",
            "--no-heading",
            "--with-filename",
            "--case-sensitive",
            "--max-count",
            "1000",
            "--glob",
            "*.ts",
            "--type",
            "typescript",
            "--fixed-strings",
            "--hidden",
            "--context",
            "20",
            "--",
            "--version",
            home,
        ]);
        expect(buildRgArgs({ pattern: "x", case_sensitive: false }, home)).toContain("--ignore-case");
    });

    test("strips one accidental @ and expands only home paths", () => {
        expect(normalizeSearchPath("@~/src", home)).toBe("/home/tester/src");
        expect(normalizeSearchPath("@@~/src", home)).toBe("@~/src");
        expect(normalizeSearchPath("~other/src", home)).toBe("~other/src");
        expect(normalizeSearchPath("relative", home)).toBe("relative");
    });

    test("enforces fd limit and depth integer bounds", () => {
        for (const limit of [0, 10_001, 1.5, Number.NaN]) expect(() => buildFdArgs({ limit }, home)).toThrow();
        for (const max_depth of [0, 65, 1.5]) expect(() => buildFdArgs({ max_depth }, home)).toThrow();
        expect(buildFdArgs({ limit: 1, max_depth: 1 }, home)).toContain("1");
    });

    test("enforces rg limit and context integer bounds", () => {
        for (const limit of [0, 1001, 1.5]) expect(() => buildRgArgs({ pattern: "x", limit }, home)).toThrow();
        for (const context of [-1, 21, 1.5]) expect(() => buildRgArgs({ pattern: "x", context }, home)).toThrow();
        expect(buildRgArgs({ pattern: "x", limit: 1, context: 0 }, home)).toContain("0");
    });
});
