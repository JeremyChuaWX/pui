import { describe, expect, test } from "bun:test";
import { createFakeClock } from "#test-support/fake-clock.ts";
import { ExtensionDialogQueue, ToastQueue } from "#ui/state/controller-queues.ts";

describe("ToastQueue", () => {
    test("keeps the three newest toasts and drops each one after its ttl", async () => {
        let changes = 0;
        const fake = createFakeClock();
        const queue = new ToastQueue(() => changes++, fake.clock);
        queue.push("a");
        await fake.advance(1_000);
        for (const message of ["b", "c", "d"]) queue.push(message);
        expect(queue.list().map((toast) => toast.message)).toEqual(["b", "c", "d"]);
        expect(changes).toBe(4);

        await fake.advance(4_000);
        expect(queue.list().map((toast) => toast.message)).toEqual(["b", "c", "d"]);
        await fake.advance(1_000);
        expect(queue.list()).toEqual([]);

        queue.push("e");
        queue.dispose();
        await fake.advance(10_000);
        expect(queue.list().map((toast) => toast.message)).toEqual(["e"]);
    });
});

describe("ExtensionDialogQueue", () => {
    test("presents dialogs first in first out and validates each answer against its kind", async () => {
        const queue = new ExtensionDialogQueue(() => {});
        const confirm = queue.request({ kind: "confirm", title: "Confirm", message: "ok?" });
        const select = queue.request({ kind: "select", title: "Pick", options: ["x", "y"] });
        const input = queue.request({ kind: "input", title: "Name" });

        expect(queue.current()).toMatchObject({ kind: "confirm", title: "Confirm" });
        expect(queue.resolve(queue.current()!.id, "not a boolean")).toBe(true);
        expect(await confirm).toBeUndefined();

        expect(queue.current()).toMatchObject({ kind: "select" });
        queue.resolve(queue.current()!.id, "z");
        expect(await select).toBeUndefined();

        expect(queue.current()).toMatchObject({ kind: "input" });
        queue.resolve(queue.current()!.id, "typed");
        expect(await input).toBe("typed");
        expect(queue.current()).toBeUndefined();
        expect(queue.resolve(999, true)).toBe(false);
    });

    test("a timeout or an aborted signal resolves the dialog to undefined and removes it", async () => {
        const fake = createFakeClock();
        const queue = new ExtensionDialogQueue(() => {}, fake.clock);
        const timed = queue.request({ kind: "confirm", title: "Slow", message: "" }, { timeout: 5_000 });
        await fake.advance(4_999);
        expect(queue.current()).toMatchObject({ title: "Slow" });
        await fake.advance(1);
        expect(await timed).toBeUndefined();
        expect(queue.current()).toBeUndefined();

        const abort = new AbortController();
        const aborted = queue.request({ kind: "input", title: "Cancel me" }, { signal: abort.signal });
        abort.abort();
        expect(await aborted).toBeUndefined();
        expect(queue.current()).toBeUndefined();

        const already = queue.request({ kind: "input", title: "Too late" }, { signal: abort.signal });
        expect(await already).toBeUndefined();
    });

    test("close dismisses every pending dialog and rejects later requests", async () => {
        const queue = new ExtensionDialogQueue(() => {});
        const pending = [
            queue.request({ kind: "input", title: "one" }),
            queue.request({ kind: "input", title: "two" }),
        ];
        queue.close();
        expect(await Promise.all(pending)).toEqual([undefined, undefined]);
        expect(await queue.request({ kind: "input", title: "after close" })).toBeUndefined();
    });
});
