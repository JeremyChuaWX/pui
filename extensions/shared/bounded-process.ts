import { type ChildProcess, spawn } from "node:child_process";
import { truncateUtf8, truncateUtf8Tail } from "./retained-output.js";

/**
 * Signal a child's whole process group when possible (taskkill /T on Windows, where signals cannot
 * reach descendants), falling back to the direct child if tree termination races with exit. Never
 * throws.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid) {
        if (process.platform === "win32") {
            try {
                const sweeper = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
                sweeper.once("error", () => {
                    try {
                        child.kill(signal);
                    } catch {
                        // The child may have exited between the checks.
                    }
                });
                sweeper.unref();
                return;
            } catch {
                // Fall back to signaling just the direct child.
            }
        } else {
            try {
                process.kill(-child.pid, signal);
                return;
            } catch {
                // Fall back to signaling just the direct child.
            }
        }
    }
    try {
        child.kill(signal);
    } catch {
        // The child may have exited between the checks.
    }
}

export type BoundedProcessFailure = "timeout" | "cancelled" | "output" | "spawn";
export class BoundedProcessError extends Error {
    constructor(
        readonly reason: BoundedProcessFailure,
        message: string,
    ) {
        super(message);
    }
}

export interface BoundedProcessRequest {
    command: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Run `command` through the platform shell. */
    shell?: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    output: {
        maxBytes: number;
        /** "fail" rejects at the limit; the keep modes silently retain one end of each stream. */
        overflow: "fail" | "keep-head" | "keep-tail";
        /** "combined" applies maxBytes to both streams together (only meaningful with "fail"). */
        scope?: "combined" | "per-stream";
    };
    /** Default sends SIGKILL immediately; graceMs sends SIGTERM first and escalates after the grace. */
    termination?: { graceMs: number };
    /** Signal only the direct child (and do not detach it into its own process group). */
    directChildOnly?: boolean;
}
export interface BoundedProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Spawn/timeout/kill in one place: shell-free (or explicit shell) spawning, process-group
 * termination with optional SIGTERM grace, an overall deadline, abort-signal cancellation, and
 * bounded output capture. Rejects with BoundedProcessError for timeout/cancel/overflow/spawn
 * failures; every exit code resolves.
 */
export function runBoundedProcess(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    if (request.signal?.aborted) return Promise.reject(new BoundedProcessError("cancelled", "Process was cancelled."));
    return new Promise((resolve, reject) => {
        const detached = !request.directChildOnly && process.platform !== "win32";
        const child = spawn(request.command, request.args ?? [], {
            cwd: request.cwd,
            env: request.env,
            shell: request.shell ?? false,
            stdio: ["ignore", "pipe", "pipe"],
            detached,
            windowsHide: true,
        });
        let stdout = "",
            stderr = "",
            settled = false,
            closed = false,
            terminationReason: "cancelled" | "timeout" | "output" | undefined,
            killTimer: NodeJS.Timeout | undefined,
            spawnError: Error | undefined;
        const sendSignal = (signal: NodeJS.Signals) => {
            if (closed) return;
            if (request.directChildOnly) {
                try {
                    child.kill(signal);
                } catch {}
            } else killProcessTree(child, signal);
        };
        const terminate = (reason: NonNullable<typeof terminationReason>) => {
            if (terminationReason || closed) return;
            terminationReason = reason;
            if (request.termination) {
                sendSignal("SIGTERM");
                killTimer = setTimeout(() => sendSignal("SIGKILL"), request.termination.graceMs);
                killTimer.unref();
            } else sendSignal("SIGKILL");
        };
        const finish = (error?: Error, result?: BoundedProcessResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            if (abort) request.signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else if (result) resolve(result);
            else reject(new BoundedProcessError("spawn", "Process returned no result."));
        };
        const abort = request.signal ? () => terminate("cancelled") : undefined;
        const append = (stream: "stdout" | "stderr", chunk: string) => {
            if (terminationReason === "output") return;
            const { maxBytes, overflow } = request.output;
            if (overflow === "keep-tail") {
                if (stream === "stdout") stdout = truncateUtf8Tail(`${stdout}${chunk}`, maxBytes).content;
                else stderr = truncateUtf8Tail(`${stderr}${chunk}`, maxBytes).content;
                return;
            }
            if (overflow === "keep-head") {
                if (stream === "stdout") stdout = truncateUtf8(`${stdout}${chunk}`, maxBytes).content;
                else stderr = truncateUtf8(`${stderr}${chunk}`, maxBytes).content;
                return;
            }
            if (stream === "stdout") stdout += chunk;
            else stderr += chunk;
            const overLimit =
                request.output.scope === "per-stream"
                    ? Buffer.byteLength(stream === "stdout" ? stdout : stderr) > maxBytes
                    : Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes;
            if (overLimit) terminate("output");
        };
        const timer = setTimeout(() => terminate("timeout"), request.timeoutMs);
        if (abort) request.signal?.addEventListener("abort", abort, { once: true });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
        child.once("error", (error) => {
            spawnError = error;
        });
        child.once("close", (code) => {
            // The direct child can exit while one of its descendants ignores SIGTERM.
            if (terminationReason) sendSignal("SIGKILL");
            closed = true;
            if (spawnError) finish(new BoundedProcessError("spawn", spawnError.message));
            else if (terminationReason === "cancelled")
                finish(new BoundedProcessError("cancelled", "Process was cancelled."));
            else if (terminationReason === "timeout") finish(new BoundedProcessError("timeout", "Process timed out."));
            else if (terminationReason === "output")
                finish(new BoundedProcessError("output", "Process output exceeded its limit."));
            else finish(undefined, { exitCode: code ?? 1, stdout, stderr });
        });
        if (request.signal?.aborted) abort?.();
    });
}
