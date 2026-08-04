/**
 * Host-side validation of the workflow worker's NDJSON transport. Worker output is untrusted:
 * every frame is checked for exact shape against the session state before the backend acts on it.
 */
export const MAX_FRAME_BYTES = 256 * 1024;
const MAX_FRAME_LINE_BYTES = MAX_FRAME_BYTES * 2 + 1024;
export const MAX_PENDING_RPCS = 16;

export type ParsedWorkerFrame =
    | { t: "ready" }
    | { t: "heartbeat" }
    | { t: "terminal"; ok: true; json?: string }
    | { t: "terminal"; ok: false; error: string }
    | { t: "rpc"; id: string; method: string; value: unknown; identity: unknown };

export interface WorkerSessionState {
    ready: boolean;
    pending: number;
}

const exact = (frame: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(frame).length === keys.length && keys.every((key) => key in frame);

/** Validate one decoded worker frame against the session state; throws on any violation. */
export function parseWorkerFrame(input: unknown, state: WorkerSessionState): ParsedWorkerFrame {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Malformed workflow worker frame.");
    const frame = input as Record<string, unknown>;
    if (frame.v !== 1 || typeof frame.t !== "string") throw new Error("Malformed workflow worker frame.");
    if (frame.t === "ready") {
        if (state.ready || !exact(frame, ["v", "t"])) throw new Error("Malformed workflow ready frame.");
        return { t: "ready" };
    }
    if (frame.t === "heartbeat") {
        if (!state.ready || !exact(frame, ["v", "t"])) throw new Error("Malformed workflow heartbeat frame.");
        return { t: "heartbeat" };
    }
    if (frame.t === "terminal") {
        if (state.pending > 0) throw new Error("Workflow worker sent a terminal frame with pending RPC requests.");
        if (
            !state.ready ||
            (frame.ok === true
                ? !(exact(frame, ["v", "t", "ok"]) || exact(frame, ["v", "t", "ok", "json"]))
                : frame.ok !== false || !exact(frame, ["v", "t", "ok", "error"])) ||
            (frame.ok === false && typeof frame.error !== "string")
        )
            throw new Error("Malformed workflow terminal frame.");
        if (frame.json !== undefined && typeof frame.json !== "string") throw new Error("Malformed workflow result.");
        if (typeof frame.json === "string" && Buffer.byteLength(frame.json) > MAX_FRAME_BYTES)
            throw new Error("Oversized workflow result.");
        return frame.ok === true
            ? { t: "terminal", ok: true, ...(frame.json !== undefined ? { json: frame.json as string } : {}) }
            : { t: "terminal", ok: false, error: frame.error as string };
    }
    if (
        frame.t !== "rpc" ||
        !state.ready ||
        typeof frame.id !== "string" ||
        typeof frame.method !== "string" ||
        !(["agent", "shell"].includes(frame.method)
            ? exact(frame, ["v", "t", "id", "method", "value", "identity"])
            : exact(frame, ["v", "t", "id", "method", "value"])) ||
        state.pending >= MAX_PENDING_RPCS
    )
        throw new Error("Invalid or excessive workflow RPC request.");
    return { t: "rpc", id: frame.id, method: frame.method, value: frame.value, identity: frame.identity };
}

/**
 * Splits worker stdout into JSON frames with per-line and buffered-tail byte caps.
 * Throws on the first transport violation; the stream must not be decoded further afterwards.
 */
export class WorkerFrameDecoder {
    private buffer = "";

    *decode(chunk: string): Generator<unknown> {
        this.buffer += chunk;
        let index = this.buffer.indexOf("\n");
        while (index >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            index = this.buffer.indexOf("\n");
            if (Buffer.byteLength(line) > MAX_FRAME_LINE_BYTES) throw new Error("Oversized workflow worker frame.");
            let frame: unknown;
            try {
                frame = JSON.parse(line);
            } catch {
                throw new Error("Malformed workflow worker output.");
            }
            yield frame;
        }
        if (Buffer.byteLength(this.buffer) > MAX_FRAME_LINE_BYTES) throw new Error("Oversized workflow worker frame.");
    }
}
