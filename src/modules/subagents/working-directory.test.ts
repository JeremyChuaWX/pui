import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWorkingDirectory } from "./working-directory.ts";

const parent = path.dirname(new URL(import.meta.url).pathname);

describe("resolveWorkingDirectory", () => {
    test("resolves relative paths from the parent cwd, strips a leading @, and expands ~", async () => {
        expect(await resolveWorkingDirectory(".", parent)).toBe(await fs.promises.realpath(parent));
        expect(await resolveWorkingDirectory(`@../${path.basename(parent)}`, parent)).toBe(
            await fs.promises.realpath(parent),
        );
        expect(await resolveWorkingDirectory("~", parent)).toBe(await fs.promises.realpath(os.homedir()));
        expect(await resolveWorkingDirectory("  ~/  ", parent)).toBe(await fs.promises.realpath(os.homedir()));
    });

    test("rejects an empty, missing, or non-directory cwd with a specific message", async () => {
        await expect(resolveWorkingDirectory(" @ ", parent)).rejects.toThrow("must not be empty");
        await expect(resolveWorkingDirectory("does-not-exist-anywhere", parent)).rejects.toThrow("does not exist");
        await expect(resolveWorkingDirectory("working-directory.ts", parent)).rejects.toThrow("is not a directory");
    });
});
