import { describe, expect, test } from "bun:test";
import { extensionConfirmKeyIntent } from "./extension-confirm-key.js";

describe("extension confirm keyboard intent", () => {
    test.each(["return", "enter", "linefeed", "y"])("approves with bare %s", (name) => {
        expect(extensionConfirmKeyIntent({ name })).toBe("approve");
    });

    test("allows shift only for Y/N", () => {
        expect(extensionConfirmKeyIntent({ name: "y", shift: true })).toBe("approve");
        expect(extensionConfirmKeyIntent({ name: "n", shift: true })).toBe("deny");
        expect(extensionConfirmKeyIntent({ name: "return", shift: true })).toBe("suppress");
        expect(extensionConfirmKeyIntent({ name: "pageup", shift: true })).toBe("suppress");
    });

    test("denies with bare escape or N, and Ctrl+C", () => {
        expect(extensionConfirmKeyIntent({ name: "escape" })).toBe("deny");
        expect(extensionConfirmKeyIntent({ name: "n" })).toBe("deny");
        expect(extensionConfirmKeyIntent({ name: "c", ctrl: true })).toBe("deny");
    });

    test("preserves bare transcript paging", () => {
        expect(extensionConfirmKeyIntent({ name: "pageup" })).toBe("page-up");
        expect(extensionConfirmKeyIntent({ name: "pagedown" })).toBe("page-down");
    });

    test.each([
        { name: "y", ctrl: true },
        { name: "n", meta: true },
        { name: "enter", option: true },
        { name: "pagedown", ctrl: true },
        { name: "c", ctrl: true, shift: true },
        { name: "escape", meta: true },
        { name: "k", ctrl: true },
        { name: "a" },
    ])("suppresses modified or unrelated key $name", (key) => {
        expect(extensionConfirmKeyIntent(key)).toBe("suppress");
    });
});
