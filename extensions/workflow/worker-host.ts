import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { killProcessTree } from "../../shared/lib/bounded-process.js";
import { errorMessage } from "../../shared/lib/validate.js";
import { boundedJson } from "./rpc-operations.js";
import { type ParsedWorkerFrame, parseWorkerFrame, WorkerFrameDecoder } from "./worker-protocol.js";

const STDERR_BYTES = 8 * 1024;

/** Ready and heartbeat frames are supervision-internal; only these reach the session's onFrame. */
export type WorkflowWorkerFrame = Extract<ParsedWorkerFrame, { t: "terminal" | "rpc" }>;

export interface WorkflowWorkerExit {
    /** The child "error" event payload; absent when the process closed normally. */
    error?: unknown;
    /** Bounded tail of the worker's stderr, for exit diagnostics. */
    stderr: string;
}

export interface WorkflowWorkerOptions {
    node: string;
    workerSource: string;
    /** Aborting terminates the worker process tree. */
    signal: AbortSignal;
    now: () => number;
    /** Worker startup deadline. */
    readyTimeoutMs: number;
    /** Worker heartbeat deadline once ready. */
    watchdogMs: number;
    /** Total wall-clock budget for the run. */
    runTimeoutMs: number;
    /** Built and sent when the worker reports ready. */
    startFrame: () => unknown;
    /** Session-side in-flight RPC count, consulted when validating incoming frames. */
    pending: () => number;
    /** Receives every validated terminal and rpc frame in decode order. */
    onFrame: (frame: WorkflowWorkerFrame) => void;
    /** Supervision failures: liveness timeouts, transport violations, and stdin errors. */
    onFailure: (message: string, options?: { abort?: boolean }) => void;
}

/**
 * Process mechanics for one sandboxed workflow worker: spawn, NDJSON frame decoding, stderr tail,
 * liveness watchdog, total run timeout, and close handling. Frame semantics stay with the caller.
 */
export class WorkflowWorker {
    /** Resolves once the child errors or closes; supervision timers are cleared before this settles. */
    readonly closed: Promise<WorkflowWorkerExit>;
    private ready = false;
    private lastBeat: number;
    private stderr = "";

    /** Materializes the worker module in a private temp directory and spawns the sandboxed child. */
    static async spawn(options: WorkflowWorkerOptions): Promise<WorkflowWorker> {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-"));
        try {
            const worker = path.join(directory, "worker.mjs");
            await fs.promises.writeFile(worker, options.workerSource, { mode: 0o600 });
            const canonical = await realpath(worker);
            const child = spawn(
                options.node,
                ["--permission", `--allow-fs-read=${canonical}`, "--max-old-space-size=128", canonical],
                { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: {} },
            );
            return new WorkflowWorker(options, directory, child);
        } catch (error) {
            await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }

    private constructor(
        private readonly options: WorkflowWorkerOptions,
        private readonly directory: string,
        private readonly child: ReturnType<typeof spawn>,
    ) {
        this.lastBeat = options.now();
        options.signal.addEventListener("abort", this.terminate, { once: true });
        if (options.signal.aborted) this.terminate();
        if (!child.stdin || !child.stdout) throw new Error("Workflow worker pipes were not created.");
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "EPIPE") options.onFailure(errorMessage(error), { abort: false });
        });
        child.stderr?.on("data", (chunk) => {
            this.stderr = Buffer.from(`${this.stderr}${chunk}`).subarray(-STDERR_BYTES).toString();
        });
        child.stdout.setEncoding("utf8");
        const decoder = new WorkerFrameDecoder();
        child.stdout.on("data", (chunk) => {
            try {
                for (const decoded of decoder.decode(chunk)) this.route(decoded);
            } catch (e) {
                options.onFailure(errorMessage(e));
            }
        });
        const watchdog = setInterval(() => {
            const limit = this.ready ? options.watchdogMs : options.readyTimeoutMs;
            if (options.now() - this.lastBeat > limit)
                options.onFailure(
                    this.ready ? "Workflow worker heartbeat timed out." : "Workflow worker did not become ready.",
                );
        }, 250);
        const total = setTimeout(() => options.onFailure("Workflow run timed out."), options.runTimeoutMs);
        this.closed = new Promise<WorkflowWorkerExit>((resolve) => {
            const settle = (exit: { error?: unknown }) => {
                clearInterval(watchdog);
                clearTimeout(total);
                resolve({ ...exit, stderr: this.stderr });
            };
            child.once("error", (error) => settle({ error }));
            child.once("close", () => settle({}));
        });
    }

    send(frame: unknown): boolean {
        const payload = `${boundedJson(frame)}\n`;
        const stdin = this.child.stdin;
        if (!stdin?.writable || stdin.writableEnded || stdin.destroyed) return false;
        return stdin.write(payload);
    }

    readonly terminate = () => {
        killProcessTree(this.child, "SIGTERM");
        setTimeout(() => killProcessTree(this.child, "SIGKILL"), 500).unref();
    };

    /** Removes the worker's temp directory; call after `closed` settles. */
    async dispose(): Promise<void> {
        await fs.promises.rm(this.directory, { recursive: true, force: true });
    }

    private route(decoded: unknown) {
        const frame = parseWorkerFrame(decoded, { ready: this.ready, pending: this.options.pending() });
        if (frame.t === "ready") {
            this.ready = true;
            this.lastBeat = this.options.now();
            this.send(this.options.startFrame());
            return;
        }
        if (frame.t === "heartbeat") {
            this.lastBeat = this.options.now();
            return;
        }
        this.options.onFrame(frame);
        if (frame.t === "terminal") {
            this.child.stdin?.end();
            this.child.kill("SIGTERM");
        }
    }
}
