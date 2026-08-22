import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { BoundedProcessError, runBoundedProcess } from "../../shared/lib/bounded-process.js";
import { errorMessage } from "../../shared/lib/validate.js";
import type { ShellRequest, ShellResult } from "./backend.js";
import { MAX_SHELL_OUTPUT_BYTES } from "./rpc-operations.js";

async function commandVersion(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
    const windowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
        executable = windowsScript ? (environment.ComSpec ?? "cmd.exe") : command,
        args = windowsScript ? ["/d", "/s", "/c", `"${command}" --version`] : ["--version"];
    let result: Awaited<ReturnType<typeof runBoundedProcess>>;
    try {
        result = await runBoundedProcess({
            command: executable,
            args,
            env: environment,
            timeoutMs: 2_000,
            directChildOnly: true,
            output: { maxBytes: 1024, overflow: "keep-head" },
        });
    } catch (error) {
        if (error instanceof BoundedProcessError && error.reason === "timeout")
            throw new Error("version probe timed out");
        throw error;
    }
    if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
    return result.stdout.trim();
}

export async function resolveWorkflowNode(
    options: { environment?: NodeJS.ProcessEnv; configuredPath?: string } = {},
): Promise<string> {
    const env = options.environment ?? process.env,
        failures: string[] = [];
    for (const [source, candidate] of [
        ["PUI_WORKFLOW_NODE", env.PUI_WORKFLOW_NODE],
        ["configured path", options.configuredPath],
        ["PATH", "node"],
    ] as const) {
        if (!candidate) continue;
        try {
            const version = await commandVersion(candidate, env),
                match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
            if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19))
                throw new Error(`found ${version}; need >=22.19.0`);
            if (candidate.includes(path.sep)) return await realpath(candidate);
            const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
            for (const directory of (env.PATH ?? "").split(path.delimiter))
                for (const extension of extensions) {
                    const located = path.join(directory || ".", `${candidate}${extension}`);
                    try {
                        await fs.promises.access(located, fs.constants.X_OK);
                        return await realpath(located);
                    } catch {}
                }
            return candidate;
        } catch (e) {
            failures.push(`${source} (${candidate}): ${errorMessage(e)}`);
        }
    }
    throw new Error(
        `Workflows require an external Node >=22.19. Set PUI_WORKFLOW_NODE. Attempts: ${failures.join("; ") || "none"}`,
    );
}

export async function runWorkflowShell(request: ShellRequest, environment: NodeJS.ProcessEnv): Promise<ShellResult> {
    try {
        return await runBoundedProcess({
            command: request.command,
            cwd: request.cwd,
            env: { ...environment, ...request.env },
            shell: true,
            timeoutMs: request.timeoutMs,
            signal: request.signal,
            termination: { graceMs: 500 },
            output: { maxBytes: MAX_SHELL_OUTPUT_BYTES, overflow: "fail", scope: "combined" },
        });
    } catch (error) {
        if (!(error instanceof BoundedProcessError)) throw error;
        if (error.reason === "cancelled") throw new Error("Shell command was cancelled.");
        if (error.reason === "timeout") throw new Error("Shell command timed out.");
        if (error.reason === "output")
            throw new Error(`Shell command output exceeds the ${MAX_SHELL_OUTPUT_BYTES / 1024} KiB limit.`);
        throw new Error(error.message);
    }
}
