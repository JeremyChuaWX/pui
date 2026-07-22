export interface FocusTrapTarget {
    readonly isDestroyed: boolean;
    focus(): void;
    on(event: "blurred", listener: () => void): unknown;
    off(event: "blurred", listener: () => void): unknown;
}

/** Restores focus after another renderable takes it, unless focus is intentionally released. */
export function trapFocus(
    target: FocusTrapTarget,
    shouldTrap: () => boolean,
    schedule: (callback: () => void) => void = (callback) => setTimeout(callback, 0),
): () => void {
    let active = true;
    const restore = () => {
        schedule(() => {
            if (active && shouldTrap() && !target.isDestroyed) target.focus();
        });
    };

    target.on("blurred", restore);
    return () => {
        active = false;
        target.off("blurred", restore);
    };
}
