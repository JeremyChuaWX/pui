import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type CapturedOutput, FileSearchOutput, isRipgrepCommand } from "./output.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const STDERR_MAX_BYTES = 64 * 1024;

export type FileSearchStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface RunFileSearchOptions {
    command: string;
    args: readonly string[];
    tool?: "fd" | "rg";
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    killGraceMs?: number;
}

export interface FileSearchProcessResult extends CapturedOutput {
    status: FileSearchStatus;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

function boundedStderr(chunks: Buffer[]): string {
    const text = Buffer.concat(chunks).toString("utf8");
    if (Buffer.byteLength(text, "utf8") <= STDERR_MAX_BYTES) return text;
    const kept: string[] = [];
    let bytes = 0;
    for (const character of text) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size > STDERR_MAX_BYTES) break;
        kept.push(character);
        bytes += size;
    }
    return kept.join("");
}

/** Execute a search binary directly, with bounded capture and process-tree termination. */
export async function runFileSearch(options: RunFileSearchOptions): Promise<FileSearchProcessResult> {
    if (options.signal?.aborted) {
        return {
            status: "cancelled",
            output: "",
            count: 0,
            totalBytes: 0,
            truncated: false,
            stderr: "",
            exitCode: null,
            signal: null,
        };
    }

    const capture = await FileSearchOutput.create();
    let child: ReturnType<typeof nodeSpawn>;
    try {
        child = nodeSpawn(options.command, [...options.args], {
            cwd: options.cwd,
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        await capture.discard();
        throw error;
    }

    let reason: "cancelled" | "timed_out" | undefined;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const sendSignal = (signal: NodeJS.Signals) => {
        if (closed) return;
        if (process.platform !== "win32" && child.pid) {
            try {
                process.kill(-child.pid, signal);
                return;
            } catch {
                // Fall back to the direct process if group signaling races with exit.
            }
        }
        try {
            child.kill(signal);
        } catch {
            // The child may have exited between checks.
        }
    };
    const terminate = (why: "cancelled" | "timed_out") => {
        if (reason || closed) return;
        reason = why;
        sendSignal("SIGTERM");
        killTimer = setTimeout(() => sendSignal("SIGKILL"), Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
    };
    const abort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => terminate("timed_out"), Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

    const stdoutTask = (async () => {
        for await (const chunk of child.stdout as Readable) await capture.write(chunk as Buffer);
    })();
    const stderrTask = (async () => {
        for await (const value of child.stderr as Readable) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            if (stderrBytes >= STDERR_MAX_BYTES) continue;
            const kept = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
            stderrChunks.push(Buffer.from(kept));
            stderrBytes += kept.length;
        }
    })();
    const closeTask = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        let spawnError: Error | undefined;
        child.once("error", (error) => {
            spawnError = error;
        });
        child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
    });

    try {
        const closedResult = await closeTask;
        // A direct child may exit on SIGTERM while a descendant ignores it.
        if (reason && killTimer) sendSignal("SIGKILL");
        closed = true;
        await Promise.all([stdoutTask, stderrTask]);
        const output = await capture.finish();
        if (closedResult.error) throw closedResult.error;
        const noMatches =
            (options.tool === "rg" || isRipgrepCommand(options.command)) &&
            closedResult.code === 1 &&
            output.totalBytes === 0;
        const status: FileSearchStatus = reason ?? (closedResult.code === 0 || noMatches ? "succeeded" : "failed");
        return {
            ...output,
            status,
            stderr: boundedStderr(stderrChunks),
            exitCode: closedResult.code,
            signal: closedResult.signal,
        };
    } catch (error) {
        await capture.discard();
        throw error;
    } finally {
        closed = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
    }
}
