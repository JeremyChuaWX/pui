import { describe, expect, test } from "bun:test";
import { parseBackgroundSubagentControl } from "./background-protocol.js";

describe("background subagent control protocol", () => {
    const valid = {
        schema: "pi.subagent.background.control",
        version: 1,
        sessionId: "session",
        instanceId: "instance",
        type: "cancel",
        jobId: "job",
    } as const;

    test("accepts only bounded versioned cancellation messages", () => {
        expect(parseBackgroundSubagentControl(valid)).toEqual(valid);
        expect(parseBackgroundSubagentControl({ ...valid, version: 2 })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, type: "steer" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, jobId: "" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, jobId: "x".repeat(257) })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, sessionId: "" })).toBeUndefined();
        expect(parseBackgroundSubagentControl({ ...valid, instanceId: null })).toBeUndefined();
    });
});
