import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES, MAX_PENDING_RPCS, parseWorkerFrame, WorkerFrameDecoder } from "./worker-protocol.js";

const initial = { ready: false, pending: 0 };
const ready = { ready: true, pending: 0 };

describe("parseWorkerFrame", () => {
    test("rejects non-object frames", () => {
        for (const frame of [null, undefined, "ready", 7, [1]])
            expect(() => parseWorkerFrame(frame, initial)).toThrow("Malformed workflow worker frame.");
    });

    test("rejects unknown protocol versions and missing types", () => {
        expect(() => parseWorkerFrame({ v: 2, t: "ready" }, initial)).toThrow("Malformed workflow worker frame.");
        expect(() => parseWorkerFrame({ v: 1 }, initial)).toThrow("Malformed workflow worker frame.");
        expect(() => parseWorkerFrame({ v: 1, t: 7 }, initial)).toThrow("Malformed workflow worker frame.");
    });

    test("accepts one exact ready frame before the session is ready", () => {
        expect(parseWorkerFrame({ v: 1, t: "ready" }, initial)).toEqual({ t: "ready" });
        expect(() => parseWorkerFrame({ v: 1, t: "ready" }, ready)).toThrow("Malformed workflow ready frame.");
        expect(() => parseWorkerFrame({ v: 1, t: "ready", extra: true }, initial)).toThrow(
            "Malformed workflow ready frame.",
        );
    });

    test("accepts heartbeats only after ready", () => {
        expect(parseWorkerFrame({ v: 1, t: "heartbeat" }, ready)).toEqual({ t: "heartbeat" });
        expect(() => parseWorkerFrame({ v: 1, t: "heartbeat" }, initial)).toThrow(
            "Malformed workflow heartbeat frame.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "heartbeat", extra: 1 }, ready)).toThrow(
            "Malformed workflow heartbeat frame.",
        );
    });

    test("accepts exact terminal frames", () => {
        expect(parseWorkerFrame({ v: 1, t: "terminal", ok: true }, ready)).toEqual({ t: "terminal", ok: true });
        expect(parseWorkerFrame({ v: 1, t: "terminal", ok: true, json: "null" }, ready)).toEqual({
            t: "terminal",
            ok: true,
            json: "null",
        });
        expect(parseWorkerFrame({ v: 1, t: "terminal", ok: false, error: "boom" }, ready)).toEqual({
            t: "terminal",
            ok: false,
            error: "boom",
        });
    });

    test("rejects malformed terminal frames", () => {
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: true }, initial)).toThrow(
            "Malformed workflow terminal frame.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: "yes" }, ready)).toThrow(
            "Malformed workflow terminal frame.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: false }, ready)).toThrow(
            "Malformed workflow terminal frame.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: false, error: 7 }, ready)).toThrow(
            "Malformed workflow terminal frame.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: true, json: "x", extra: 1 }, ready)).toThrow(
            "Malformed workflow terminal frame.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: true, json: 7 }, ready)).toThrow(
            "Malformed workflow result.",
        );
    });

    test("rejects a terminal frame while RPC requests are pending", () => {
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: true }, { ready: true, pending: 1 })).toThrow(
            "Workflow worker sent a terminal frame with pending RPC requests.",
        );
    });

    test("bounds the terminal result at the frame limit", () => {
        const json = JSON.stringify("x".repeat(MAX_FRAME_BYTES - 2));
        expect(Buffer.byteLength(json)).toBe(MAX_FRAME_BYTES);
        expect(parseWorkerFrame({ v: 1, t: "terminal", ok: true, json }, ready)).toMatchObject({ ok: true });
        expect(() => parseWorkerFrame({ v: 1, t: "terminal", ok: true, json: `${json}x` }, ready)).toThrow(
            "Oversized workflow result.",
        );
    });

    test("accepts exact RPC frames and requires identity for agent and shell", () => {
        const agent = { v: 1, t: "rpc", id: "1", method: "agent", value: {}, identity: "site#1" };
        expect(parseWorkerFrame(agent, ready)).toEqual({
            t: "rpc",
            id: "1",
            method: "agent",
            value: {},
            identity: "site#1",
        });
        expect(parseWorkerFrame({ v: 1, t: "rpc", id: "1", method: "phase", value: null }, ready)).toMatchObject({
            method: "phase",
        });
        expect(() => parseWorkerFrame({ v: 1, t: "rpc", id: "1", method: "agent", value: {} }, ready)).toThrow(
            "Invalid or excessive workflow RPC request.",
        );
        expect(() =>
            parseWorkerFrame({ v: 1, t: "rpc", id: "1", method: "phase", value: null, identity: "x#1" }, ready),
        ).toThrow("Invalid or excessive workflow RPC request.");
    });

    test("rejects unknown frame types and RPCs before ready", () => {
        expect(() => parseWorkerFrame({ v: 1, t: "mystery" }, ready)).toThrow(
            "Invalid or excessive workflow RPC request.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "rpc", id: "1", method: "phase", value: null }, initial)).toThrow(
            "Invalid or excessive workflow RPC request.",
        );
        expect(() => parseWorkerFrame({ v: 1, t: "rpc", id: 1, method: "phase", value: null }, ready)).toThrow(
            "Invalid or excessive workflow RPC request.",
        );
    });

    test("caps concurrent pending RPC requests", () => {
        const frame = { v: 1, t: "rpc", id: "1", method: "phase", value: null };
        expect(parseWorkerFrame(frame, { ready: true, pending: MAX_PENDING_RPCS - 1 })).toMatchObject({ t: "rpc" });
        expect(() => parseWorkerFrame(frame, { ready: true, pending: MAX_PENDING_RPCS })).toThrow(
            "Invalid or excessive workflow RPC request.",
        );
    });
});

describe("WorkerFrameDecoder", () => {
    test("yields coalesced frames from one chunk and buffers partial lines", () => {
        const decoder = new WorkerFrameDecoder();
        expect([...decoder.decode('{"a":1}\n{"b":2}\n{"c"')]).toEqual([{ a: 1 }, { b: 2 }]);
        expect([...decoder.decode(":3}\n")]).toEqual([{ c: 3 }]);
    });

    test("rejects malformed JSON lines and stops decoding", () => {
        const decoder = new WorkerFrameDecoder();
        const frames: unknown[] = [];
        expect(() => {
            for (const frame of decoder.decode('{"a":1}\nnot-json\n{"b":2}\n')) frames.push(frame);
        }).toThrow("Malformed workflow worker output.");
        expect(frames).toEqual([{ a: 1 }]);
    });

    test("rejects an oversized frame line", () => {
        const decoder = new WorkerFrameDecoder();
        expect(() => [...decoder.decode(`${"x".repeat(2 * MAX_FRAME_BYTES + 1025)}\n`)]).toThrow(
            "Oversized workflow worker frame.",
        );
    });

    test("rejects an oversized unterminated buffer", () => {
        const decoder = new WorkerFrameDecoder();
        expect(() => [...decoder.decode("x".repeat(2 * MAX_FRAME_BYTES + 1025))]).toThrow(
            "Oversized workflow worker frame.",
        );
    });
});
