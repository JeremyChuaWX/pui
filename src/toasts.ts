import type { ToastMessage } from "./types.js";

const TOAST_TTL_MS = 5_000;
const MAX_VISIBLE_TOASTS = 3;

/** Bounded, self-expiring notification list. */
export class ToastQueue {
    private toasts: ToastMessage[] = [];
    private nextId = 0;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();

    constructor(private readonly onChange: () => void) {}

    push(message: string, type: ToastMessage["type"] = "info"): void {
        const toast = { id: ++this.nextId, message, type };
        this.toasts = [...this.toasts.slice(-(MAX_VISIBLE_TOASTS - 1)), toast];
        this.onChange();

        const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.toasts = this.toasts.filter((candidate) => candidate.id !== toast.id);
            this.onChange();
        }, TOAST_TTL_MS);
        this.timers.add(timer);
    }

    list(): ToastMessage[] {
        return [...this.toasts];
    }

    dispose(): void {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }
}
