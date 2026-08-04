export interface BackgroundEventAPI {
    emit(channel: string, payload: object): void;
    on(channel: string, listener: (payload: unknown) => void): (() => void) | undefined;
}

export type BackgroundEventType = "ready" | "reset" | "upsert" | "remove";

export interface BackgroundChannelOptions<R extends object, C> {
    events: BackgroundEventAPI | undefined;
    eventChannel: string;
    controlChannel: string;
    parseControl(payload: unknown): C | undefined;
    controlRoute(control: C): R;
    envelope(type: BackgroundEventType, route: R, extra: object): object;
    onControl(control: C): void;
}

/** Producer-side lifecycle and route enforcement for a background event channel. */
export function createBackgroundChannel<R extends object, C>(options: BackgroundChannelOptions<R, C>) {
    let unsubscribe: (() => void) | undefined;
    let route: R | undefined;

    const matchesRoute = (candidate: R, expected: R) =>
        Object.entries(expected).every(([field, value]) => (candidate as Record<string, unknown>)[field] === value);
    const emit = (type: BackgroundEventType, extra: object = {}, target = route) => {
        if (target) options.events?.emit(options.eventChannel, options.envelope(type, target, extra));
    };

    return {
        bind(next: R): void {
            unsubscribe?.();
            route = next;
            unsubscribe = options.events?.on(options.controlChannel, (payload) => {
                const control = options.parseControl(payload);
                if (!control || route !== next || !matchesRoute(options.controlRoute(control), next)) return;
                options.onControl(control);
            });
        },
        emit,
        ready(target?: R): void {
            emit("ready", {}, target);
        },
        async shutdown(work: () => Promise<void>, shouldReset: () => boolean = () => true): Promise<void> {
            const closingRoute = route;
            unsubscribe?.();
            unsubscribe = undefined;
            route = undefined;
            await work();
            if (closingRoute && shouldReset()) emit("reset", {}, closingRoute);
        },
    };
}
