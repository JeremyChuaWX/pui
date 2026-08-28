import { describe, expect, test } from "bun:test";
import { createBackgroundChannel } from "./background-channel.ts";

describe("background channel", () => {
    test("subscribes once, validates every route field, and emits lifecycle envelopes", async () => {
        const listeners = new Map<string, (payload: unknown) => void>();
        const emitted: Array<[string, object]> = [];
        let handled = 0;
        let unsubscribed = 0;
        const channel = createBackgroundChannel({
            events: {
                emit: (name, payload) => emitted.push([name, payload]),
                on: (name, listener) => {
                    listeners.set(name, listener);
                    return () => {
                        unsubscribed++;
                        listeners.delete(name);
                    };
                },
            },
            eventChannel: "events",
            controlChannel: "controls",
            parseControl: (value: unknown) =>
                typeof value === "object" && value !== null
                    ? (value as { sessionId: string; instanceId: string; cwd: string })
                    : undefined,
            controlRoute: (control) => control,
            envelope: (type, route, extra) => ({ type, ...route, ...extra }),
            onControl: () => handled++,
        });
        const route = { sessionId: "session", instanceId: "instance", cwd: "/canonical" };

        channel.bind(route);
        channel.ready();
        listeners.get("controls")?.({ ...route });
        listeners.get("controls")?.({ ...route, sessionId: "other" });
        listeners.get("controls")?.({ ...route, instanceId: "other" });
        listeners.get("controls")?.({ ...route, cwd: "/other" });
        expect(handled).toBe(1);

        await channel.shutdown(async () => {});
        expect(unsubscribed).toBe(1);
        expect(emitted.map(([, payload]) => payload)).toEqual([
            { type: "ready", ...route },
            { type: "reset", ...route },
        ]);
    });

    test("rejects stale listeners after rebind and suppresses stale shutdown reset", async () => {
        const listeners: Array<(payload: unknown) => void> = [];
        let handled = 0;
        let resets = 0;
        const channel = createBackgroundChannel({
            events: {
                emit: (_name, payload) => {
                    if ((payload as { type?: string }).type === "reset") resets++;
                },
                on: (_name, next) => {
                    listeners.push(next);
                    return () => {};
                },
            },
            eventChannel: "events",
            controlChannel: "controls",
            parseControl: (value) => value as { sessionId: string },
            controlRoute: (control) => control,
            envelope: (type, route) => ({ type, ...route }),
            onControl: () => handled++,
        });
        channel.bind({ sessionId: "first" });
        channel.bind({ sessionId: "second" });
        listeners[0]?.({ sessionId: "first" });
        listeners[1]?.({ sessionId: "first" });
        listeners[1]?.({ sessionId: "second" });
        expect(handled).toBe(1);

        await channel.shutdown(
            async () => {},
            () => false,
        );
        expect(resets).toBe(0);
    });
});
