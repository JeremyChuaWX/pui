/**
 * Serializes the workflow extension's session epochs. Each session_start begins an epoch (aborting
 * the previous one); session_shutdown ends it. Work that spans awaits re-checks `stale()` after
 * every suspension, and initialization/shutdown are serialized through one queue so epochs never
 * overlap on the backend.
 */
export interface SessionEpoch {
    /** Aborts when a newer epoch begins or the session shuts down. */
    signal: AbortSignal;
    /** True once a newer epoch has begun. */
    stale(): boolean;
}

export interface WorkflowLaunchContext {
    sessionId: string;
    signal: AbortSignal | undefined;
    /** True while the epoch, session, and (canonicalized) cwd are all unchanged since capture. */
    unchanged(canonicalCwd: string): boolean;
}

export class SessionLifecycle {
    sessionId = "unbound";
    cwd = "";
    private generation = 0;
    private controller: AbortController | undefined;
    private queue: Promise<void> = Promise.resolve();
    private unsubscribeControl: (() => void) | undefined;

    beginEpoch(): SessionEpoch {
        const generation = ++this.generation;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        return { signal: controller.signal, stale: () => generation !== this.generation || controller.signal.aborted };
    }

    endEpoch(): SessionEpoch {
        const generation = ++this.generation;
        this.controller?.abort();
        this.controller = undefined;
        this.setControlSubscription(undefined);
        const controller = new AbortController();
        return { signal: controller.signal, stale: () => generation !== this.generation };
    }

    bind(route: { sessionId: string; cwd: string }): void {
        this.sessionId = route.sessionId;
        this.cwd = route.cwd;
    }

    setControlSubscription(unsubscribe: (() => void) | undefined): void {
        this.unsubscribeControl?.();
        this.unsubscribeControl = unsubscribe;
    }

    /** Serialize initialization and shutdown work; failures do not wedge the queue. */
    enqueue<T>(work: () => Promise<T>): Promise<T> {
        const task = this.queue.then(work);
        this.queue = task.then(
            () => undefined,
            () => undefined,
        );
        return task;
    }

    /** Capture launch identity before an approval prompt; validate it after with `unchanged`. */
    launchContext(): WorkflowLaunchContext {
        const generation = this.generation,
            sessionId = this.sessionId;
        return {
            sessionId,
            signal: this.controller?.signal,
            unchanged: (canonicalCwd) =>
                generation === this.generation && sessionId === this.sessionId && canonicalCwd === this.cwd,
        };
    }
}
