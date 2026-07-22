import { describe, expect, test } from "bun:test";
import { JsonLineParser } from "./json-events.ts";

describe("JsonLineParser", () => {
    test("parses fragmented, combined, CRLF, and final unterminated lines", () => {
        const values: unknown[] = [];
        const parser = new JsonLineParser({ onValue: (value) => values.push(value) });

        const payload = Buffer.from(
            '{"type":"turn_start","label":"😀"}\n{"type":"agent_settled"}\r\n{"tail":true}',
            "utf8",
        );
        parser.write(payload.subarray(0, 8));
        parser.write(payload.subarray(8, 31));
        parser.write(payload.subarray(31, 39));
        parser.end(payload.subarray(39));

        expect(values).toEqual([{ type: "turn_start", label: "😀" }, { type: "agent_settled" }, { tail: true }]);
    });

    test("turns malformed and oversized lines into bounded diagnostics and continues", () => {
        const values: unknown[] = [];
        const diagnostics: string[] = [];
        const parser = new JsonLineParser({
            onValue: (value) => values.push(value),
            onDiagnostic: (message) => diagnostics.push(message),
            maxLineBytes: 24,
            diagnosticPreviewBytes: 8,
        });

        parser.write(`{bad json}\n${"x".repeat(100)}`);
        parser.write('\n{"ok":true}\n');
        parser.end();

        expect(values).toEqual([{ ok: true }]);
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[0]).toContain("malformed");
        expect(diagnostics[1]).toContain("oversized");
        expect(Buffer.byteLength(diagnostics.join(""), "utf8")).toBeLessThan(300);
    });

    test("ignores writes after end", () => {
        const values: unknown[] = [];
        const parser = new JsonLineParser({ onValue: (value) => values.push(value) });
        parser.end('{"first":1}\n');
        parser.write('{"second":2}\n');
        expect(values).toEqual([{ first: 1 }]);
    });
});
