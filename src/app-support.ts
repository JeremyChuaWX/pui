import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { KeyEvent, Selection } from "@opentui/core";

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

export interface SelectionSource {
    getSelection(): Selection | null;
}

type ClipboardWriter = (text: string) => void | Promise<void>;

/** Copy the current OpenTUI selection through the native clipboard with OSC 52 fallback. */
export async function copyCurrentSelection(
    source: SelectionSource,
    writeClipboard: ClipboardWriter = copyToClipboard,
): Promise<boolean> {
    const text = source.getSelection()?.getSelectedText() ?? "";
    if (text.length === 0) return false;
    await writeClipboard(text);
    return true;
}

/**
 * Treat Ctrl-C as copy while text is highlighted because legacy terminal paths,
 * including tmux without extended-key forwarding, cannot preserve Shift.
 */
export function isCopyShortcut(key: Pick<KeyEvent, "name" | "ctrl" | "shift">, hasSelection = false): boolean {
    return key.name.toLowerCase() === "c" && key.ctrl && (key.shift || hasSelection);
}

export const REFERENCE_MARKER = "# ------------------------ >8 ------------------------";
export const REFERENCE_INSTRUCTION = "# Everything above is reference only and will be ignored.";

export function buildEditorBuffer(reference: string, draft: string): string {
    if (!reference.trim()) return draft;
    return `${reference.trimEnd()}\n\n${REFERENCE_MARKER}\n${REFERENCE_INSTRUCTION}\n\n${draft}`;
}

export function extractEditedPrompt(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const markerIndex = lines.findIndex((line) => line.trimEnd() === REFERENCE_MARKER);
    if (markerIndex === -1) return text.replace(/\n$/, "");

    let start = markerIndex + 1;
    if ((lines[start] ?? "").trimEnd() === REFERENCE_INSTRUCTION) start += 1;
    if ((lines[start] ?? "") === "") start += 1;
    return lines.slice(start).join("\n").replace(/\n$/, "");
}

function waitForExit(command: string, args: string[], cwd: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: "inherit" });
        child.once("error", reject);
        child.once("close", resolve);
    });
}

export async function editPromptInNvim(draft: string, reference: string, cwd: string): Promise<string | undefined> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "pui-editor-"));
    const tempFile = path.join(tempDirectory, "prompt.pi.md");

    try {
        await writeFile(tempFile, buildEditorBuffer(reference, draft), "utf8");
        const status = await waitForExit("nvim", [tempFile], cwd);
        if (status !== 0) return undefined;

        const edited = extractEditedPrompt(await readFile(tempFile, "utf8"));
        return edited.trim() ? edited : undefined;
    } finally {
        await rm(tempDirectory, { recursive: true, force: true });
    }
}

const DEFAULT_HISTORY_LIMIT = 100;

/** In-memory history for prompts entered during the current pui process. */
export class PromptHistory {
    private readonly entries: string[] = [];
    private index = -1;
    private draft = "";
    private traversing = false;

    constructor(private readonly limit = DEFAULT_HISTORY_LIMIT) {}

    get isTraversing(): boolean {
        return this.traversing;
    }

    add(text: string): void {
        this.resetBrowsing();
        const trimmed = text.trim();
        if (!trimmed || this.limit <= 0 || this.entries[0] === trimmed) return;

        this.entries.unshift(trimmed);
        if (this.entries.length > this.limit) this.entries.length = this.limit;
    }

    previous(currentText: string): string | undefined {
        const nextIndex = this.index + 1;
        if (nextIndex >= this.entries.length) return undefined;

        if (this.index === -1) this.draft = currentText;
        this.index = nextIndex;
        this.traversing = true;
        return this.entries[this.index];
    }

    next(): string | undefined {
        if (this.index === -1) return undefined;

        this.index -= 1;
        if (this.index === -1) {
            this.traversing = false;
            return this.draft;
        }
        return this.entries[this.index];
    }

    resetBrowsing(): void {
        this.index = -1;
        this.draft = "";
        this.traversing = false;
    }
}
