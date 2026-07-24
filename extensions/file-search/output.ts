import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

export interface CapturedOutput {
    output: string;
    count: number;
    totalBytes: number;
    truncated: boolean;
    fullOutputPath?: string;
}

/** Streams all bytes to disk while retaining only Pi's context-sized head in memory. */
export class FileSearchOutput {
    readonly directory: string;
    readonly path: string;
    private readonly stream: WriteStream;
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
        return new FileSearchOutput(directory, path, stream);
    }

    async write(chunk: Buffer | string): Promise<void> {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.length === 0) return;
        this.totalBytes += bytes.length;
        for (const byte of bytes) if (byte === 10) this.newlineCount++;
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
            this.stream.once("error", reject);
            this.stream.end(resolve);
        });
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

export function isRipgrepCommand(command: string): boolean {
    return basename(command).toLowerCase() === "rg" || basename(command).toLowerCase() === "rg.exe";
}
