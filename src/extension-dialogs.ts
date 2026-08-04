import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionDialog } from "./types.js";

type ExtensionDialogSpec =
    | Omit<Extract<ExtensionDialog, { kind: "confirm" }>, "id">
    | Omit<Extract<ExtensionDialog, { kind: "select" }>, "id">
    | Omit<Extract<ExtensionDialog, { kind: "input" }>, "id">;

const MAX_PENDING_DIALOGS = 32;
const MAX_TITLE = 512;
/** A 64 KiB workflow script plus approval headers must remain inspectable byte-for-byte. */
const MAX_CONFIRM_MESSAGE = 72 * 1024;
const MAX_INPUT_PLACEHOLDER = 1_024;
const MAX_SELECT_OPTIONS = 100;
const MAX_SELECT_OPTION_LENGTH = 4_096;

/**
 * FIFO queue for dialogs requested by extensions. Enforces bounds on untrusted
 * content, honors abort signals and timeouts, and validates the resolved value
 * against the dialog kind before delivering it back to the extension.
 */
export class ExtensionDialogQueue {
    private queue: Array<{
        dialog: ExtensionDialog;
        resolve: (value: boolean | string | undefined) => void;
        cleanup: () => void;
    }> = [];
    private nextId = 0;
    private closed = false;

    constructor(private readonly onChange: () => void) {}

    /** The dialog currently presented to the user, if any. */
    current(): ExtensionDialog | undefined {
        return this.queue[0]?.dialog;
    }

    request(value: ExtensionDialogSpec, options?: ExtensionUIDialogOptions): Promise<boolean | string | undefined> {
        if (
            this.closed ||
            options?.signal?.aborted ||
            this.queue.length >= MAX_PENDING_DIALOGS ||
            value.title.length > MAX_TITLE ||
            (value.kind === "confirm" && value.message.length > MAX_CONFIRM_MESSAGE) ||
            (value.kind === "input" && (value.placeholder?.length ?? 0) > MAX_INPUT_PLACEHOLDER) ||
            (value.kind === "select" &&
                (value.options.length > MAX_SELECT_OPTIONS ||
                    value.options.some((option) => option.length > MAX_SELECT_OPTION_LENGTH)))
        )
            return Promise.resolve(undefined);
        return new Promise((resolve) => {
            const dialog = { ...value, id: ++this.nextId } as ExtensionDialog;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const abort = () => this.resolve(dialog.id, undefined);
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                options?.signal?.removeEventListener("abort", abort);
            };
            this.queue.push({ dialog, resolve, cleanup });
            options?.signal?.addEventListener("abort", abort, { once: true });
            if (options?.timeout !== undefined) timer = setTimeout(abort, Math.max(0, options.timeout));
            this.onChange();
        });
    }

    resolve(id: number, value: boolean | string | undefined): boolean {
        const index = this.queue.findIndex((request) => request.dialog.id === id);
        if (index < 0) return false;
        const [request] = this.queue.splice(index, 1);
        if (!request) return false;
        request.cleanup();
        const resolved =
            request.dialog.kind === "confirm"
                ? typeof value === "boolean"
                    ? value
                    : undefined
                : request.dialog.kind === "select"
                  ? typeof value === "string" && request.dialog.options.includes(value)
                      ? value
                      : undefined
                  : typeof value === "string"
                    ? value
                    : undefined;
        request.resolve(resolved);
        this.onChange();
        return true;
    }

    dismissAll(): void {
        const pending = this.queue.splice(0);
        for (const request of pending) {
            request.cleanup();
            request.resolve(undefined);
        }
        this.onChange();
    }

    close(): void {
        this.closed = true;
        this.dismissAll();
    }
}
