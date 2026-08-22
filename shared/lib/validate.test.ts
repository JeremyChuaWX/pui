import { describe, expect, test } from "bun:test";
import { boundedString, errorMessage, isRecord } from "./validate.js";

describe("shared validation", () => {
    test("recognizes only records", () => {
        expect(isRecord({ value: 1 })).toBe(true);
        expect(isRecord(null)).toBe(false);
        expect(isRecord([])).toBe(false);
    });

    test("bounds strings without splitting surrogate pairs", () => {
        expect(boundedString("abc", 0)).toBe("");
        expect(boundedString("a😀b", 3)).toBe("a…");
        expect(boundedString("abc", 3)).toBe("abc");
    });

    test("normalizes thrown values", () => {
        expect(errorMessage(new Error("failure"))).toBe("failure");
        expect(errorMessage("failure")).toBe("failure");
    });
});
