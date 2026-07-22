export type SemaphoreRelease = () => void;

interface Waiter {
    resolve: (release: SemaphoreRelease) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export function createAbortError(message = "Operation cancelled while queued."): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

/** A small abort-aware FIFO semaphore shared by all subagent tool executions. */
export class AbortableSemaphore {
    private activeCount = 0;
    private readonly waiters: Waiter[] = [];

    constructor(readonly limit: number) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer.");
    }

    get active(): number {
        return this.activeCount;
    }

    get queued(): number {
        return this.waiters.length;
    }

    acquire(signal?: AbortSignal): Promise<SemaphoreRelease> {
        if (signal?.aborted) return Promise.reject(createAbortError());
        if (this.activeCount < this.limit) {
            this.activeCount++;
            return Promise.resolve(this.makeRelease());
        }

        return new Promise<SemaphoreRelease>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, signal };
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index !== -1) this.waiters.splice(index, 1);
                    reject(createAbortError());
                };
                signal.addEventListener("abort", waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }

    private makeRelease(): SemaphoreRelease {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.activeCount--;
            this.drain();
        };
    }

    private drain(): void {
        while (this.activeCount < this.limit && this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            if (!waiter) break;
            if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
            if (waiter.signal?.aborted) {
                waiter.reject(createAbortError());
                continue;
            }
            this.activeCount++;
            waiter.resolve(this.makeRelease());
        }
    }
}

export function configuredSubagentConcurrency(value = process.env.PI_SUBAGENT_MAX_CONCURRENCY): number {
    if (!value?.trim()) return 4;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : 4;
}
