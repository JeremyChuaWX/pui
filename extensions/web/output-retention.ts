import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

/** Maximum complete-output bytes retained for a single result. */
const MAX_RETAINED_RESULT_BYTES = 10 * 1024 * 1024;
/** Maximum complete-output bytes retained by one session owner. */
const MAX_RETAINED_SESSION_BYTES = 50 * 1024 * 1024;

/** A bounded tool result and, when retained successfully, its complete-output file. */
interface RetainedWebOutput {
    /** Text bounded by the requested byte and line limits. */
    text: string;
    /** Whether the complete input was omitted from `text`. */
    truncated: boolean;
    /** Session-owned path to the complete input; absent when it was not retained. */
    fullOutputPath?: string;
}

/** Injectable filesystem operations used to create and remove private retained-output files. */
export interface WebOutputRetentionFileSystem {
    mkdtemp(prefix: string): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    writeFile(path: string, data: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

/** Optional storage and quota overrides for a session retention owner. */
export interface WebOutputRetentionDependencies {
    /** Filesystem implementation; defaults to Node's filesystem promises API. */
    fileSystem?: WebOutputRetentionFileSystem;
    /** Per-result complete-output quota in UTF-8 bytes. */
    maxRetainedResultBytes?: number;
    /** Aggregate complete-output quota in UTF-8 bytes for this owner. */
    maxRetainedSessionBytes?: number;
}

type RetentionFailure = "closed" | "result-quota" | "session-quota" | "storage";
type WriteResult = { path: string } | { failure: "closed" | "storage" };

const defaultFileSystem: WebOutputRetentionFileSystem = {
    mkdtemp,
    chmod,
    writeFile: (path, data, options) => writeFile(path, data, options),
    rm,
};

function normalizedLimit(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function truncateUtf8(text: string, maxBytes: number): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes) return text;
    let end = Math.min(bytes.length, maxBytes);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
}

/** Owns bounded previews and private complete-output files for one web-extension session at a time. */
export class WebOutputRetention {
    private readonly fileSystem: WebOutputRetentionFileSystem;
    private readonly maxRetainedResultBytes: number;
    private readonly maxRetainedSessionBytes: number;
    private readonly directories = new Set<string>();
    private readonly pending = new Set<Promise<RetainedWebOutput>>();
    private retainedBytes = 0;
    private closed = false;
    private cleanupPromise: Promise<boolean> | undefined;

    /** Creates a retention owner whose files live until cleanup. */
    constructor(dependencies: WebOutputRetentionDependencies = {}) {
        this.fileSystem = dependencies.fileSystem ?? defaultFileSystem;
        this.maxRetainedResultBytes = normalizedLimit(dependencies.maxRetainedResultBytes ?? MAX_RETAINED_RESULT_BYTES);
        this.maxRetainedSessionBytes = normalizedLimit(
            dependencies.maxRetainedSessionBytes ?? MAX_RETAINED_SESSION_BYTES,
        );
    }

    /**
     * Reopens this owner so a new session can retain results after an earlier cleanup.
     *
     * Directories whose removal failed stay tracked, so the next cleanup retries them.
     */
    startSession(): void {
        this.closed = false;
        this.cleanupPromise = undefined;
    }

    /**
     * Returns `fullText` unchanged when it fits; otherwise returns a bounded preview and attempts to retain the complete text.
     *
     * After cleanup begins and until the next `startSession`, truncated results refuse retention because
     * the session is shutting down.
     *
     * @param fullText - Complete web-tool output to bound and, if needed, retain.
     * @param limits - Maximum UTF-8 bytes and lines allowed in the returned `text`.
     * @returns A bounded result with `fullOutputPath` only when complete-output retention succeeds.
     */
    retain(fullText: string, limits: { maxBytes: number; maxLines: number }): Promise<RetainedWebOutput> {
        const normalizedLimits = {
            maxBytes: normalizedLimit(limits.maxBytes),
            maxLines: normalizedLimit(limits.maxLines),
        };
        const truncation = truncateHead(fullText, normalizedLimits);
        if (!truncation.truncated) {
            return Promise.resolve({ text: fullText, truncated: false });
        }

        const retainedSize = truncation.totalBytes;
        if (retainedSize > this.maxRetainedResultBytes) {
            return Promise.resolve(this.boundedResult(fullText, normalizedLimits, undefined, "result-quota"));
        }
        if (this.closed) {
            return Promise.resolve(this.boundedResult(fullText, normalizedLimits, undefined, "closed"));
        }
        if (this.retainedBytes + retainedSize > this.maxRetainedSessionBytes) {
            return Promise.resolve(this.boundedResult(fullText, normalizedLimits, undefined, "session-quota"));
        }

        // This reservation happens before any asynchronous filesystem operation can begin.
        this.retainedBytes += retainedSize;
        let reservationActive = true;
        const releaseReservation = () => {
            if (!reservationActive) return;
            reservationActive = false;
            this.retainedBytes -= retainedSize;
        };
        let pending!: Promise<RetainedWebOutput>;
        pending = this.write(fullText)
            .then((result) => {
                if ("path" in result) return this.boundedResult(fullText, normalizedLimits, result.path);
                releaseReservation();
                return this.boundedResult(fullText, normalizedLimits, undefined, result.failure);
            })
            .catch(() => {
                releaseReservation();
                return this.boundedResult(fullText, normalizedLimits, undefined, "storage");
            })
            .finally(() => this.pending.delete(pending));
        this.pending.add(pending);
        return pending;
    }

    /**
     * Closes this owner, waits for pending writes, and removes its retained-output directories.
     *
     * Concurrent calls share the active cleanup. A `false` result means removal was incomplete and a later call retries it.
     *
     * @returns Whether all session-owned directories were removed.
     */
    cleanup(): Promise<boolean> {
        if (this.cleanupPromise) return this.cleanupPromise;
        this.closed = true;
        this.cleanupPromise = this.cleanupOwnedOutput().then((complete) => {
            if (!complete) this.cleanupPromise = undefined;
            return complete;
        });
        return this.cleanupPromise;
    }

    private async cleanupOwnedOutput(): Promise<boolean> {
        await Promise.allSettled([...this.pending]);
        const directories = [...this.directories];
        await Promise.allSettled(directories.map((directory) => this.removeDirectory(directory)));
        this.retainedBytes = 0;
        return this.directories.size === 0;
    }

    private async write(output: string): Promise<WriteResult> {
        let directory: string | undefined;
        try {
            directory = await this.fileSystem.mkdtemp(join(tmpdir(), "pui-web-output-"));
            this.directories.add(directory);
            if (this.closed) {
                await this.removeDirectory(directory);
                return { failure: "closed" };
            }

            await this.fileSystem.chmod(directory, 0o700);
            if (this.closed) {
                await this.removeDirectory(directory);
                return { failure: "closed" };
            }

            const outputPath = join(directory, "result.md");
            await this.fileSystem.writeFile(outputPath, output, { encoding: "utf8", mode: 0o600 });
            await this.fileSystem.chmod(outputPath, 0o600);
            if (!this.closed) return { path: outputPath };
            await this.removeDirectory(directory);
            return { failure: "closed" };
        } catch {
            if (directory) await this.removeDirectory(directory);
            return { failure: this.closed ? "closed" : "storage" };
        }
    }

    private async removeDirectory(directory: string): Promise<void> {
        try {
            await this.fileSystem.rm(directory, { recursive: true, force: true });
            this.directories.delete(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") this.directories.delete(directory);
            // Other failures stay tracked so a later cleanup call can retry them.
        }
    }

    private boundedResult(
        fullText: string,
        limits: { maxBytes: number; maxLines: number },
        fullOutputPath?: string,
        failure?: RetentionFailure,
    ): RetainedWebOutput {
        const totalBytes = Buffer.byteLength(fullText, "utf8");
        const totalLines = fullText.length === 0 ? 0 : fullText.split("\n").length - (fullText.endsWith("\n") ? 1 : 0);
        const summary = `complete result is ${formatSize(totalBytes)} across ${totalLines} ${totalLines === 1 ? "line" : "lines"}`;
        const notice = fullOutputPath
            ? `[Output truncated: ${summary}. Complete output retained at: ${JSON.stringify(fullOutputPath)}]`
            : `[Output truncated: ${summary}. Complete output was not retained: ${this.failureReason(failure ?? "storage")}.]`;
        const noticeText = truncateUtf8(notice, limits.maxBytes);

        if (limits.maxLines < 1 || limits.maxBytes < 1) {
            return { text: "", truncated: true, ...(fullOutputPath && { fullOutputPath }) };
        }
        if (noticeText !== notice || limits.maxLines < 3) {
            return { text: noticeText, truncated: true, ...(fullOutputPath && { fullOutputPath }) };
        }

        const separator = "\n\n";
        const previewMaxBytes =
            limits.maxBytes - Buffer.byteLength(notice, "utf8") - Buffer.byteLength(separator, "utf8");
        const preview =
            previewMaxBytes > 0
                ? truncateHead(fullText, {
                      maxBytes: previewMaxBytes,
                      maxLines: limits.maxLines - 2,
                  }).content
                : "";
        const text = preview ? `${preview}${separator}${notice}` : notice;
        return { text, truncated: true, ...(fullOutputPath && { fullOutputPath }) };
    }

    private failureReason(failure: RetentionFailure): string {
        if (failure === "closed") return "the web-extension session is shutting down";
        if (failure === "result-quota") {
            return `it exceeds the ${formatSize(this.maxRetainedResultBytes)} per-result retention quota`;
        }
        if (failure === "session-quota") {
            return `the ${formatSize(this.maxRetainedSessionBytes)} session retention quota has insufficient capacity`;
        }
        return "temporary storage failed";
    }
}
