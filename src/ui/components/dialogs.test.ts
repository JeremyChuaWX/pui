import { describe, expect, test } from "bun:test";
import { extensionDialogState } from "./dialogs.js";

function recordingCallbacks() {
    const resolved: Array<{ id: number; value: string }> = [];
    let closed = 0;
    return {
        resolved,
        closedCount: () => closed,
        callbacks: {
            resolve: (id: number, value: string) => void resolved.push({ id, value }),
            close: () => {
                closed += 1;
            },
        },
    };
}

describe("extensionDialogState", () => {
    test("confirm requests yield no modal dialog", () => {
        const { callbacks } = recordingCallbacks();
        expect(
            extensionDialogState({ id: 1, kind: "confirm", title: "Allow?", message: "Do it" }, callbacks),
        ).toBeUndefined();
    });

    test("select requests become an owned picker whose items resolve and close", () => {
        const { resolved, closedCount, callbacks } = recordingCallbacks();
        const state = extensionDialogState(
            { id: 7, kind: "select", title: "Pick one", options: ["Alpha", "Beta"] },
            callbacks,
        );
        if (state?.kind !== "picker") throw new Error("expected a picker dialog");
        expect(state.title).toBe("Pick one");
        expect(state.placeholder).toBe("Choose an option");
        expect(state.extensionRequestId).toBe(7);
        expect(state.items.map(({ label, search }) => ({ label, search }))).toEqual([
            { label: "Alpha", search: "alpha" },
            { label: "Beta", search: "beta" },
        ]);

        state.items[1]?.action();
        expect(resolved).toEqual([{ id: 7, value: "Beta" }]);
        expect(closedCount()).toBe(1);
    });

    test("input requests become an owned input whose action resolves and closes", () => {
        const { resolved, closedCount, callbacks } = recordingCallbacks();
        const state = extensionDialogState(
            { id: 3, kind: "input", title: "Name it", placeholder: "run name" },
            callbacks,
        );
        if (state?.kind !== "input") throw new Error("expected an input dialog");
        expect(state.title).toBe("Name it");
        expect(state.placeholder).toBe("run name");
        expect(state.extensionRequestId).toBe(3);

        state.action("chosen");
        expect(resolved).toEqual([{ id: 3, value: "chosen" }]);
        expect(closedCount()).toBe(1);
    });
});
