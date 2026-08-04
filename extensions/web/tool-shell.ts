import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { WebOutputRetention } from "./output-retention.ts";

/** Provider dependencies shared by the web search and crawl tools. */
export type WebToolDependencies = {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    environment?: Record<string, string | undefined>;
};

/** Returns the trimmed string when `value` is a non-empty string. */
export function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Runs one web-tool call through the shared retention and error shell.
 *
 * Reports the starting update, runs the provider, bounds the provider's full text through the session's
 * output retention, and spreads `truncated`/`fullOutputPath` into the provider details. Failures — including
 * an aborted signal — rethrow as `"<tool> failed: <message>"`.
 */
export async function executeWebTool<Details, ProviderDetails extends object>(options: {
    toolName: string;
    cancelledMessage: string;
    outputRetention: WebOutputRetention;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<Details> | undefined;
    starting: { text: string; details: Details };
    limits: { maxBytes: number; maxLines: number };
    run: () => Promise<{ fullText: string; details: ProviderDetails }>;
}): Promise<AgentToolResult<ProviderDetails & { truncated: boolean; fullOutputPath?: string }>> {
    const { signal } = options;
    options.onUpdate?.({
        content: [{ type: "text", text: options.starting.text }],
        details: options.starting.details,
    });

    try {
        const { fullText, details } = await options.run();
        if (signal?.aborted) throw new Error(options.cancelledMessage);
        const formatted = await options.outputRetention.retain(fullText, options.limits);
        return {
            content: [{ type: "text", text: formatted.text }],
            details: {
                ...details,
                truncated: formatted.truncated,
                ...(formatted.fullOutputPath && { fullOutputPath: formatted.fullOutputPath }),
            },
        };
    } catch (error) {
        const message = signal?.aborted
            ? options.cancelledMessage
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(`${options.toolName} failed: ${message}`, { cause: error });
    }
}
