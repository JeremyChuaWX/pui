import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Normalise a model-supplied cwd: strip a stray leading @, expand ~, resolve relative paths from the parent cwd. */
function workingDirectoryCandidate(input: string, parentCwd: string): string {
    let value = input.trim().replace(/^@/, "");
    if (!value) return path.resolve(parentCwd);
    if (value === "~") value = os.homedir();
    else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
    return path.resolve(parentCwd, value);
}

export async function resolveWorkingDirectory(input: string, parentCwd: string): Promise<string> {
    if (!input.trim().replace(/^@/, "")) throw new Error("Subagent cwd must not be empty.");
    const resolved = workingDirectoryCandidate(input, parentCwd);
    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(resolved);
    } catch {
        throw new Error(`Subagent cwd does not exist: ${resolved}`);
    }
    if (!stats.isDirectory()) throw new Error(`Subagent cwd is not a directory: ${resolved}`);
    return fs.promises.realpath(resolved);
}
