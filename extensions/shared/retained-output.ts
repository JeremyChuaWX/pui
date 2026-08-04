import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Maximum complete-output bytes retained for a single result. */
const MAX_RETAINED_RESULT_BYTES = 10 * 1024 * 1024;
/** Maximum complete-output bytes retained by one session owner. */
const MAX_RETAINED_SESSION_BYTES = 50 * 1024 * 1024;

export type RetentionFailure = "closed" | "result-quota" | "session-quota" | "storage";
export type RetainedSaveResult = { path: string } | { failure: RetentionFailure };

/** Injectable filesystem operations used to create and remove private retained-output files. */
export interface RetainedOutputFileSystem {
    mkdtemp(prefix: string): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    writeFile(path: string, data: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const defaultFileSystem: RetainedOutputFileSystem = {
    mkdtemp,
    chmod,
    writeFile: (path, data, options) => writeFile(path, data, options),
    rm,
};

export interface RetainedOutputStoreOptions {
    /** Temp-directory prefix, e.g. "pui-web-output-". */
    prefix: string;
    /** File name inside each retained directory, e.g. "result.md". */
    fileName: string;
    /** Filesystem implementation; defaults to Node's filesystem promises API. */
    fileSystem?: RetainedOutputFileSystem;
    /** Per-result complete-output quota in UTF-8 bytes. */
    maxResultBytes?: number;
    /** Aggregate complete-output quota in UTF-8 bytes for this owner. */
    maxSessionBytes?: number;
}

function normalizedLimit(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Owns private (0700 directory / 0600 file) complete-output files for one extension session at a
 * time, with per-result and per-session byte quotas. `cleanup` closes the owner, awaits pending
 * writes, and removes every retained directory; failed removals stay tracked so a later cleanup
 * retries them. `startSession` reopens the owner for the next session.
 */
export class RetainedOutputStore {
    readonly maxResultBytes: number;
    readonly maxSessionBytes: number;
    private readonly prefix: string;
    private readonly fileName: string;
    private readonly fileSystem: RetainedOutputFileSystem;
    private readonly directories = new Set<string>();
    private readonly pending = new Set<Promise<RetainedSaveResult>>();
    private retainedBytes = 0;
    private closed = false;
    private cleanupPromise: Promise<boolean> | undefined;

    constructor(options: RetainedOutputStoreOptions) {
        this.prefix = options.prefix;
        this.fileName = options.fileName;
        this.fileSystem = options.fileSystem ?? defaultFileSystem;
        this.maxResultBytes = normalizedLimit(options.maxResultBytes ?? MAX_RETAINED_RESULT_BYTES);
        this.maxSessionBytes = normalizedLimit(options.maxSessionBytes ?? MAX_RETAINED_SESSION_BYTES);
    }

    /** Reopens this owner so a new session can retain results after an earlier cleanup. */
    startSession(): void {
        this.closed = false;
        this.cleanupPromise = undefined;
    }

    /** Retain one complete output; failures identify why the caller's notice should say it was lost. */
    save(output: string): Promise<RetainedSaveResult> {
        const size = Buffer.byteLength(output, "utf8");
        if (size > this.maxResultBytes) return Promise.resolve({ failure: "result-quota" });
        if (this.closed) return Promise.resolve({ failure: "closed" });
        if (this.retainedBytes + size > this.maxSessionBytes) return Promise.resolve({ failure: "session-quota" });

        // This reservation happens before any asynchronous filesystem operation can begin.
        this.retainedBytes += size;
        let reservationActive = true;
        const releaseReservation = () => {
            if (!reservationActive) return;
            reservationActive = false;
            this.retainedBytes -= size;
        };
        let pending!: Promise<RetainedSaveResult>;
        pending = this.write(output)
            .then((result) => {
                if ("failure" in result) releaseReservation();
                return result;
            })
            .catch((): RetainedSaveResult => {
                releaseReservation();
                return { failure: "storage" };
            })
            .finally(() => this.pending.delete(pending));
        this.pending.add(pending);
        return pending;
    }

    /** Like save, but collapses failures to undefined for callers that do not report reasons. */
    async savePath(output: string): Promise<string | undefined> {
        const result = await this.save(output);
        return "path" in result ? result.path : undefined;
    }

    /**
     * Closes this owner, waits for pending writes, and removes its retained-output directories.
     * Concurrent calls share the active cleanup; `false` means removal was incomplete and a later
     * call retries it.
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

    private async write(output: string): Promise<RetainedSaveResult> {
        let directory: string | undefined;
        try {
            directory = await this.fileSystem.mkdtemp(join(tmpdir(), this.prefix));
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

            const outputPath = join(directory, this.fileName);
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
}
