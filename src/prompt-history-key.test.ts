import { describe, expect, test } from "bun:test";
import { promptHistoryDirection } from "./prompt-history-key.js";

describe("promptHistoryDirection", () => {
    test.each([
        [{ name: "up" }, "previous"],
        [{ name: "p", ctrl: true }, "previous"],
        [{ name: "down" }, "next"],
        [{ name: "n", ctrl: true }, "next"],
    ] as const)("maps %o to %s", (key, direction) => {
        expect(promptHistoryDirection(key)).toBe(direction);
    });

    test.each([
        { name: "p" },
        { name: "n" },
        { name: "left" },
        { name: "up", shift: true },
        { name: "up", meta: true },
        { name: "down", option: true },
        { name: "down", ctrl: true },
    ])("ignores %o", (key) => {
        expect(promptHistoryDirection(key)).toBeUndefined();
    });
});
