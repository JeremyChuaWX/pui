import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { killProcessTree } from "../shared/bounded-process.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const STDERR_MAX_BYTES = 64 * 1024;

type FileSearchStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

interface CapturedOutput {
    output: string;
    count: number;
    totalBytes: number;
    truncated: boolean;
    fullOutputPath?: string;
    cleanup?: () => Promise<void>;
}

/** The capture seam `runFileSearch` uses; tests may inject a fake via `createCapture`. */
export interface OutputCapture {
    write(chunk: Buffer | string): Promise<void>;
    finish(): Promise<CapturedOutput>;
    discard(): Promise<void>;
}

export interface RunFileSearchOptions {
    command: string;
    args: readonly string[];
    tool: "fd" | "rg";
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    killGraceMs?: number;
    createCapture?: () => Promise<OutputCapture>;
}

export interface FileSearchProcessResult extends CapturedOutput {
    status: FileSearchStatus;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

/** Streams all bytes to disk while retaining only Pi's context-sized head in memory. */
class FileSearchOutput implements OutputCapture {
    readonly directory: string;
    readonly path: string;
    private readonly stream: WriteStream;
    private streamError: Error | undefined;
    private readonly head: Buffer[] = [];
    private headBytes = 0;
    private totalBytes = 0;
    private newlineCount = 0;
    private lastByte: number | undefined;
    private finished = false;

    private constructor(directory: string, path: string, stream: WriteStream) {
        this.directory = directory;
        this.path = path;
        this.stream = stream;
    }

    static async create(): Promise<FileSearchOutput> {
        const directory = await mkdtemp(join(tmpdir(), "pui-file-search-"));
        await chmod(directory, 0o700);
        const path = join(directory, "output.txt");
        const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
            stream.once("open", () => resolve());
            stream.once("error", reject);
        });
        const output = new FileSearchOutput(directory, path, stream);
        // Latch mid-stream failures so write/finish surface them instead of a stale reject.
        stream.removeAllListeners("error");
        stream.on("error", (error: Error) => {
            output.streamError ??= error;
        });
        return output;
    }

    async write(chunk: Buffer | string): Promise<void> {
        if (this.streamError) throw this.streamError;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.length === 0) return;
        this.totalBytes += bytes.length;
        let newline = bytes.indexOf(10);
        while (newline !== -1) {
            this.newlineCount++;
            newline = bytes.indexOf(10, newline + 1);
        }
        this.lastByte = bytes.at(-1);
        if (this.headBytes < DEFAULT_MAX_BYTES) {
            const kept = bytes.subarray(0, DEFAULT_MAX_BYTES - this.headBytes);
            this.head.push(Buffer.from(kept));
            this.headBytes += kept.length;
        }
        if (!this.stream.write(bytes)) {
            await new Promise<void>((resolve, reject) => {
                const onDrain = () => {
                    this.stream.off("error", onError);
                    resolve();
                };
                const onError = (error: Error) => {
                    this.stream.off("drain", onDrain);
                    reject(error);
                };
                this.stream.once("drain", onDrain);
                this.stream.once("error", onError);
            });
        }
    }

    async finish(): Promise<CapturedOutput> {
        if (this.finished) throw new Error("File-search output was already finalized");
        this.finished = true;
        await new Promise<void>((resolve, reject) => {
            this.stream.end(() => (this.streamError ? reject(this.streamError) : resolve()));
        });
        if (this.streamError) throw this.streamError;
        await chmod(this.path, 0o600);

        const head = Buffer.concat(this.head).toString("utf8");
        const truncation = truncateHead(head, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        const count = this.totalBytes === 0 ? 0 : this.newlineCount + (this.lastByte === 10 ? 0 : 1);
        const truncated = this.totalBytes > DEFAULT_MAX_BYTES || count > DEFAULT_MAX_LINES || truncation.truncated;
        if (!truncated) {
            await rm(this.directory, { recursive: true, force: true });
            return { output: truncation.content, count, totalBytes: this.totalBytes, truncated: false };
        }
        return {
            output: truncation.content,
            count,
            totalBytes: this.totalBytes,
            truncated: true,
            fullOutputPath: this.path,
            cleanup: () => rm(this.directory, { recursive: true, force: true }),
        };
    }

    async discard(): Promise<void> {
        if (!this.finished) {
            this.finished = true;
            this.stream.destroy();
        }
        await rm(this.directory, { recursive: true, force: true });
    }
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

function cancelledResult(): FileSearchProcessResult {
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

/** Execute a search binary directly, with bounded capture and process-tree termination. */
export async function runFileSearch(options: RunFileSearchOptions): Promise<FileSearchProcessResult> {
    if (options.signal?.aborted) return cancelledResult();

    const capture = await (options.createCapture ?? FileSearchOutput.create)();
    if (options.signal?.aborted) {
        await capture.discard();
        return cancelledResult();
    }

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
        killProcessTree(child, signal);
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

    const closeTask = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        let spawnError: Error | undefined;
        child.once("error", (error) => {
            spawnError = error;
        });
        child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
    });
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

    try {
        const closedResult = await closeTask;
        // A direct child may exit on SIGTERM while a descendant ignores it.
        if (reason && killTimer) sendSignal("SIGKILL");
        closed = true;
        const readers = await Promise.allSettled([stdoutTask, stderrTask]);
        if (closedResult.error) throw closedResult.error;
        const readerError = readers.find((reader) => reader.status === "rejected");
        if (readerError?.status === "rejected") throw readerError.reason;
        const output = await capture.finish();
        const noMatches = options.tool === "rg" && closedResult.code === 1 && output.totalBytes === 0;
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
