import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
