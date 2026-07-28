import { describe, expect, test } from "bun:test";
import { extensionDialogOwner } from "./dialog-owner.js";

describe("extension dialog ownership", () => {
    test("does not assign local dialogs to a queued extension request", () => {
        expect(extensionDialogOwner({})).toBeUndefined();
        expect(extensionDialogOwner({ extensionRequestId: 7 })).toBe(7);
        expect(extensionDialogOwner(undefined)).toBeUndefined();
    });
});
