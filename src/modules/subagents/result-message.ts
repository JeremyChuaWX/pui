import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, keyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { truncateUtf8 } from "#shared/lib/retained-output.js";
import { seconds } from "./manager.js";
import type { JobResult } from "./protocol.js";

/** Maximum UTF-8 bytes retained in the inline result preview. */
const INLINE_LIMIT = 16 * 1024;
const TRUNCATION_NOTICE = "\n\n[truncated; read the full output file]";

/** Persisted with the custom message so renderers do not have to parse its content. */
export interface SubagentResultDetails {
    id: string;
    profile: string;
    task: string;
    status: JobResult["status"];
    runtimeMs: number;
    partial: boolean;
    totalTokens?: number;
    error?: string;
    location: string;
    preview: string;
}

export interface PreparedResultMessage {
    content: string;
    details: SubagentResultDetails;
}

/** "completed in 11s, 2k tokens, partial output" */
function summary(details: SubagentResultDetails): string {
    const tokens = details.totalTokens === undefined ? "" : `, ${Math.round(details.totalTokens / 1_000)}k tokens`;
    return `${details.status} in ${seconds(details.runtimeMs)}${tokens}${details.partial ? ", partial output" : ""}`;
}

function writeOutput(dir: string, id: string, text: string): string {
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (let suffix = 1; ; suffix++) {
            const location = path.join(dir, suffix === 1 ? `${id}.md` : `${id}-${suffix}.md`);
            try {
                fs.writeFileSync(location, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
                return location;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
                throw error;
            }
        }
    } catch (error) {
        return `not written (${error instanceof Error ? error.message : String(error)})`;
    }
}

function inlinePreview(body: string): string {
    if (Buffer.byteLength(body, "utf8") <= INLINE_LIMIT) return body;
    const bodyLimit = INLINE_LIMIT - Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
    return `${truncateUtf8(body, bodyLimit).content}${TRUNCATION_NOTICE}`;
}

/** Persist complete output and prepare the bounded message injected into parent context. */
export function prepareResultMessage(result: JobResult, dir: string): PreparedResultMessage {
    const { job } = result;
    const body = result.error ? `Error: ${result.error}\n\n${result.text}` : result.text;
    const details: SubagentResultDetails = {
        id: job.id,
        profile: job.profile,
        task: job.task,
        status: result.status,
        runtimeMs: result.runtimeMs,
        partial: result.partial,
        totalTokens: result.usage?.totalTokens,
        error: result.error,
        location: writeOutput(dir, job.id, result.text || (result.error ?? "")),
        preview: inlinePreview(body),
    };
    const header = `[${details.id}] ${summary(details)}\nTask: ${details.task}\nFull output: ${details.location}`;
    return { content: `${header}\n\n${details.preview}`.trimEnd(), details };
}

function compactTask(task: string): string {
    const oneLine = task.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** Render like a tool result in Pi's TUI. pui has a matching OpenTUI presentation. */
export const renderResultMessage: MessageRenderer<SubagentResultDetails> = (message, { expanded }, theme) => {
    const details = message.details;
    if (!details?.id) return undefined;

    const succeeded = details.status === "completed";
    const color = succeeded ? "success" : "error";
    const icon = succeeded ? "✓" : details.status === "timed_out" ? "⏱" : "✗";
    const box = new Box(1, 1, (text) => theme.bg(succeeded ? "toolSuccessBg" : "toolErrorBg", text));
    box.addChild(
        new Text(
            `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(`[${details.id}]`))} ${theme.fg("dim", summary(details))}`,
            0,
            0,
        ),
    );

    if (!expanded) {
        const hint = keyHint("app.tools.expand", "to expand");
        box.addChild(
            new Text(`${theme.fg("dim", `Task: ${compactTask(details.task)} (`)}${hint}${theme.fg("dim", ")")}`, 0, 0),
        );
        return box;
    }

    box.addChild(
        new Text(
            `${theme.fg("muted", "Task:")} ${details.task}\n${theme.fg("muted", "Full output:")} ${details.location}`,
            0,
            0,
        ),
    );
    if (details.preview) {
        box.addChild(new Spacer(1));
        box.addChild(new Markdown(details.preview, 0, 0, getMarkdownTheme()));
    }
    return box;
};
