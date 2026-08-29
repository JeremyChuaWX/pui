/**
 * The time source and timer scheduler a long-running process owner depends on. Production uses
 * the system clock; tests inject a fake that only moves when the test advances it.
 */
export interface Clock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Detach a timer from the event loop when the handle supports it, so a pending timer never keeps a process alive. */
export function unrefTimer(handle: unknown): void {
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") {
        handle.unref();
    }
}
