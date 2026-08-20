import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import {
    composeBoundedOutput,
    type RetainedOutputFileSystem,
    RetainedOutputStore,
    type RetentionFailure,
} from "../shared/retained-output.js";

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
export type WebOutputRetentionFileSystem = RetainedOutputFileSystem;

/** Optional storage and quota overrides for a session retention owner. */
export interface WebOutputRetentionDependencies {
    /** Filesystem implementation; defaults to Node's filesystem promises API. */
    fileSystem?: WebOutputRetentionFileSystem;
    /** Per-result complete-output quota in UTF-8 bytes. */
    maxRetainedResultBytes?: number;
    /** Aggregate complete-output quota in UTF-8 bytes for this owner. */
    maxRetainedSessionBytes?: number;
}

function normalizedLimit(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Owns bounded previews and private complete-output files for one web-extension session at a time. */
export class WebOutputRetention {
    private readonly store: RetainedOutputStore;

    /** Creates a retention owner whose files live until cleanup. */
    constructor(dependencies: WebOutputRetentionDependencies = {}) {
        this.store = new RetainedOutputStore({
            prefix: "pui-web-output-",
            fileName: "result.md",
            fileSystem: dependencies.fileSystem,
            maxResultBytes: dependencies.maxRetainedResultBytes,
            maxSessionBytes: dependencies.maxRetainedSessionBytes,
        });
    }

    /**
     * Reopens this owner so a new session can retain results after an earlier cleanup.
     *
     * Directories whose removal failed stay tracked, so the next cleanup retries them.
     */
    startSession(): void {
        this.store.startSession();
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
    async retain(fullText: string, limits: { maxBytes: number; maxLines: number }): Promise<RetainedWebOutput> {
        const normalizedLimits = {
            maxBytes: normalizedLimit(limits.maxBytes),
            maxLines: normalizedLimit(limits.maxLines),
        };
        const truncation = truncateHead(fullText, normalizedLimits);
        if (!truncation.truncated) return { text: fullText, truncated: false };
        const result = await this.store.save(fullText);
        return "path" in result
            ? this.boundedResult(fullText, normalizedLimits, result.path)
            : this.boundedResult(fullText, normalizedLimits, undefined, result.failure);
    }

    /**
     * Closes this owner, waits for pending writes, and removes its retained-output directories.
     *
     * Concurrent calls share the active cleanup. A `false` result means removal was incomplete and a later call retries it.
     *
     * @returns Whether all session-owned directories were removed.
     */
    cleanup(): Promise<boolean> {
        return this.store.cleanup();
    }

    private boundedResult(
        fullText: string,
        limits: { maxBytes: number; maxLines: number },
        fullOutputPath?: string,
        failure?: RetentionFailure,
    ): RetainedWebOutput {
        const text = composeBoundedOutput(
            fullText,
            limits,
            fullOutputPath
                ? { retainedPath: fullOutputPath }
                : { nonRetentionReason: this.failureReason(failure ?? "storage") },
        );
        return { text, truncated: true, ...(fullOutputPath && { fullOutputPath }) };
    }

    private failureReason(failure: RetentionFailure): string {
        if (failure === "closed") return "the web-extension session is shutting down";
        if (failure === "result-quota") {
            return `it exceeds the ${formatSize(this.store.maxResultBytes)} per-result retention quota`;
        }
        if (failure === "session-quota") {
            return `the ${formatSize(this.store.maxSessionBytes)} session retention quota has insufficient capacity`;
        }
        return "temporary storage failed";
    }
}
