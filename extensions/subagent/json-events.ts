import { StringDecoder } from "node:string_decoder";
import { truncateUtf8 } from "./protocol.js";

export interface JsonLineParserOptions {
  onValue: (value: unknown) => void;
  onDiagnostic?: (message: string) => void;
  maxLineBytes?: number;
  diagnosticPreviewBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_PREVIEW_BYTES = 512;

/** Incrementally parses JSONL across arbitrary byte chunks without retaining unbounded lines. */
export class JsonLineParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly onValue: (value: unknown) => void;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly maxLineBytes: number;
  private readonly diagnosticPreviewBytes: number;
  private buffer = "";
  private droppingOversizedLine = false;
  private ended = false;

  constructor(options: JsonLineParserOptions) {
    this.onValue = options.onValue;
    this.onDiagnostic = options.onDiagnostic;
    this.maxLineBytes = Math.max(1, Math.floor(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES));
    this.diagnosticPreviewBytes = Math.max(
      1,
      Math.floor(options.diagnosticPreviewBytes ?? DEFAULT_DIAGNOSTIC_PREVIEW_BYTES),
    );
  }

  write(chunk: Uint8Array | string): void {
    if (this.ended) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    this.pushText(text);
  }

  end(chunk?: Uint8Array | string): void {
    if (this.ended) return;
    if (chunk !== undefined) this.write(chunk);
    const tail = this.decoder.end();
    if (tail) this.pushText(tail);
    if (!this.droppingOversizedLine && this.buffer.length > 0) this.processLine(this.buffer);
    this.buffer = "";
    this.droppingOversizedLine = false;
    this.ended = true;
  }

  private pushText(text: string): void {
    let remaining = text;
    while (remaining.length > 0) {
      if (this.droppingOversizedLine) {
        const newline = remaining.indexOf("\n");
        if (newline === -1) return;
        remaining = remaining.slice(newline + 1);
        this.droppingOversizedLine = false;
        continue;
      }

      const newline = remaining.indexOf("\n");
      const segment = newline === -1 ? remaining : remaining.slice(0, newline);
      const candidateBytes = Buffer.byteLength(this.buffer, "utf8") + Buffer.byteLength(segment, "utf8");
      if (candidateBytes > this.maxLineBytes) {
        const preview = truncateUtf8(this.buffer + segment, this.diagnosticPreviewBytes).content;
        this.onDiagnostic?.(
          `Ignored oversized child JSON line (limit ${this.maxLineBytes} bytes): ${JSON.stringify(preview)}`,
        );
        this.buffer = "";
        if (newline === -1) {
          this.droppingOversizedLine = true;
          return;
        }
      } else if (newline === -1) {
        this.buffer += segment;
        return;
      } else {
        this.processLine(this.buffer + segment);
        this.buffer = "";
      }

      remaining = newline === -1 ? "" : remaining.slice(newline + 1);
    }
  }

  private processLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    try {
      this.onValue(JSON.parse(line) as unknown);
    } catch {
      const preview = truncateUtf8(line, this.diagnosticPreviewBytes).content;
      this.onDiagnostic?.(`Ignored malformed child JSON: ${JSON.stringify(preview)}`);
    }
  }
}
