import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, resolveFdBinary, resolveRgBinary } from "./binaries.ts";

describe("file-search binary resolution", () => {
    test("prefers fd over fdfind and falls back in order", () => {
        const calls: string[] = [];
        expect(
            resolveFdBinary((name) => {
                calls.push(name);
                return name === "fd" ? "/bin/fd" : "/bin/fdfind";
            }),
        ).toEqual({ command: "/bin/fd", source: "system" });
        expect(calls).toEqual(["fd"]);

        calls.length = 0;
        expect(
            resolveFdBinary((name) => {
                calls.push(name);
                return name === "fdfind" ? "/bin/fdfind" : undefined;
            }),
        ).toEqual({ command: "/bin/fdfind", source: "system" });
        expect(calls).toEqual(["fd", "fdfind"]);
    });

    test("resolves rg", () => {
        expect(resolveRgBinary((name) => (name === "rg" ? "/bin/rg" : undefined))).toEqual({
            command: "/bin/rg",
            source: "system",
        });
    });

    test("returns actionable missing-binary errors", () => {
        expect(() => resolveFdBinary(() => undefined)).toThrow("Install fd");
        expect(() => resolveFdBinary(() => undefined)).toThrow("fd-find");
        expect(() => resolveRgBinary(() => undefined)).toThrow("Install ripgrep");
    });

    test("finds executables on PATH and ignores non-executable files", async () => {
        if (process.platform === "win32") return;
        const first = await mkdtemp(join(tmpdir(), "pui-bin-first-"));
        const second = await mkdtemp(join(tmpdir(), "pui-bin-second-"));
        try {
            await writeFile(join(first, "fd"), "");
            await writeFile(join(second, "fd"), "");
            await mkdir(join(first, "rg"), { mode: 0o700 });
            await writeFile(join(second, "rg"), "");
            await chmod(join(first, "fd"), 0o600);
            await chmod(join(second, "fd"), 0o700);
            await chmod(join(second, "rg"), 0o700);
            expect(findExecutable("fd", { PATH: `${first}:${second}` })).toBe(join(second, "fd"));
            expect(findExecutable("rg", { PATH: `${first}:${second}` })).toBe(join(second, "rg"));
        } finally {
            await Promise.all([
                rm(first, { recursive: true, force: true }),
                rm(second, { recursive: true, force: true }),
            ]);
        }
    });
});
