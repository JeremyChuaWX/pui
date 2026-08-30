import type { Clock } from "#shared/lib/clock.js";

interface PendingTimer {
    at: number;
    sequence: number;
    callback: () => void;
}

/** Let pending promise chains and stream data events run before time moves again. */
export function settleEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A Clock that only moves when a test advances it. Timers fire in due order, and the event loop
 * settles after each one so the code under test can react before the next timer is due.
 */
export function createFakeClock(start = 1_000_000) {
    let now = start;
    let sequence = 0;
    const timers = new Map<number, PendingTimer>();
    const clock: Clock = {
        now: () => now,
        setTimeout(callback, delayMs) {
            const id = ++sequence;
            timers.set(id, { at: now + Math.max(0, delayMs), sequence: id, callback });
            return id;
        },
        clearTimeout(handle) {
            if (typeof handle === "number") timers.delete(handle);
        },
    };
    const nextDue = (): [number, PendingTimer] | undefined => {
        let due: [number, PendingTimer] | undefined;
        for (const entry of timers) {
            if (!due || entry[1].at < due[1].at || (entry[1].at === due[1].at && entry[1].sequence < due[1].sequence))
                due = entry;
        }
        return due;
    };
    return {
        clock,
        get now() {
            return now;
        },
        pending() {
            return timers.size;
        },
        /** Move time forward, firing every timer that comes due on the way. */
        async advance(ms: number): Promise<void> {
            const target = now + ms;
            await settleEventLoop();
            for (let due = nextDue(); due && due[1].at <= target; due = nextDue()) {
                timers.delete(due[0]);
                now = due[1].at;
                due[1].callback();
                await settleEventLoop();
            }
            now = target;
            await settleEventLoop();
        },
    };
}

export type FakeClock = ReturnType<typeof createFakeClock>;
