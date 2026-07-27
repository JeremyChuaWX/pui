import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WebOutputRetentionAdapter } from "./output-retention.ts";

const CRAWL_PARAMS = Type.Object({
    url: Type.String({ minLength: 1, description: "HTTP(S) URL to scrape with Firecrawl." }),
    max_bytes: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: DEFAULT_MAX_BYTES,
            description: "Maximum bytes to return. Defaults to 50KB and cannot exceed 50KB.",
        }),
    ),
});

type FirecrawlMetadata = Record<string, unknown>;

type CrawlResult = {
    requestedUrl: string;
    sourceUrl: string;
    title?: string;
    content: string;
    metadata?: FirecrawlMetadata;
};

type CrawlDetails =
    | { status: "scraping"; url: string; maxBytes: number }
    | {
          status: "complete";
          provider: "firecrawl";
          requestedUrl: string;
          sourceUrl: string;
          title?: string;
          metadata?: FirecrawlMetadata;
          maxBytes: number;
          contentBytes: number;
          truncated: boolean;
          fullOutputPath?: string;
      };

const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";

export type WebCrawlDependencies = {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    environment?: Record<string, string | undefined>;
};

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function clampMaxBytes(value: unknown): number {
    const resolved = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_BYTES;
    return Math.max(1, Math.min(DEFAULT_MAX_BYTES, resolved));
}

function normalizeHttpUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error("web_crawl requires a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("web_crawl only accepts HTTP(S) URLs.");
    }
    if (url.username || url.password) throw new Error("web_crawl does not accept URLs containing credentials.");
    return url.toString();
}

function firecrawlScrapeUrl(environment: Record<string, string | undefined>): string {
    const configured = environment.FIRECRAWL_API_URL?.trim() || FIRECRAWL_DEFAULT_BASE_URL;
    let endpoint: URL;
    try {
        endpoint = new URL(configured);
    } catch {
        throw new Error("FIRECRAWL_API_URL must be a valid HTTP(S) URL.");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new Error("FIRECRAWL_API_URL must use HTTP(S).");
    }

    const base = endpoint.toString().replace(/\/+$/, "");
    if (base.endsWith("/scrape")) return base;
    if (base.endsWith("/v2")) return `${base}/scrape`;
    return `${base}/v2/scrape`;
}

function parseFirecrawlPayload(text: string): Record<string, unknown> {
    try {
        const payload = text ? JSON.parse(text) : {};
        const object = objectValue(payload);
        if (!object) throw new Error("response was not an object");
        return object;
    } catch {
        throw new Error(`Firecrawl returned invalid JSON: ${text.slice(0, 700)}`);
    }
}

async function scrapeWithFirecrawl(
    url: string,
    signal: AbortSignal | undefined,
    dependencies: WebCrawlDependencies,
): Promise<CrawlResult> {
    const environment = dependencies.environment ?? process.env;
    const apiKey = environment.FIRECRAWL_API_KEY?.trim();
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set.");

    const response = await (dependencies.fetch ?? globalThis.fetch)(firecrawlScrapeUrl(environment), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            url,
            formats: ["markdown"],
            onlyMainContent: true,
        }),
        signal,
    });
    const text = await response.text();
    const payload = parseFirecrawlPayload(text);
    const errorMessage = nonEmptyString(payload.error) ?? nonEmptyString(payload.message) ?? text.slice(0, 700);
    if (!response.ok || payload.success === false) {
        throw new Error(`Firecrawl scrape returned HTTP ${response.status}: ${errorMessage}`);
    }

    const data = objectValue(payload.data) ?? payload;
    const content = nonEmptyString(data.markdown) ?? nonEmptyString(data.content);
    if (!content) throw new Error("Firecrawl returned no Markdown content.");

    const metadata = objectValue(data.metadata);
    const title = nonEmptyString(metadata?.title) ?? nonEmptyString(data.title);
    const sourceUrl = nonEmptyString(metadata?.sourceURL) ?? nonEmptyString(metadata?.url) ?? url;
    return { requestedUrl: url, sourceUrl, title, content, metadata };
}

function formatCrawlResult(result: CrawlResult): string {
    return [
        `Web crawl result for ${result.requestedUrl}:`,
        "Provider: Firecrawl",
        result.title ? `Title: ${result.title}` : undefined,
        `Source URL: ${result.sourceUrl}`,
        "",
        "Content:",
        result.content,
    ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
}

export default function webCrawlExtension(
    pi: ExtensionAPI,
    dependencies: WebCrawlDependencies,
    outputRetention: WebOutputRetentionAdapter,
) {
    pi.registerTool<typeof CRAWL_PARAMS, CrawlDetails>({
        name: "web_crawl",
        label: "Web Crawl",
        description:
            "Scrape one HTTP(S) URL with Firecrawl and return its main content as LLM-friendly Markdown. Requires FIRECRAWL_API_KEY. Output is capped at 50KB.",
        promptSnippet: "Extract the main content of a specific URL as Markdown using Firecrawl.",
        promptGuidelines: [
            "Use web_crawl when a specific URL is provided and its page content or details must be extracted.",
            "Use web_search for discovery or natural-language web queries; use web_crawl only for a known URL.",
            "When using web_crawl, cite the returned source URL and identify Firecrawl as the extraction provider.",
            "web_crawl requires FIRECRAWL_API_KEY; FIRECRAWL_API_URL may configure a hosted or self-hosted API base URL.",
        ],
        parameters: CRAWL_PARAMS,
        async execute(_toolCallId, params, signal, onUpdate) {
            const maxBytes = clampMaxBytes(params.max_bytes);
            onUpdate?.({
                content: [{ type: "text", text: `Scraping with Firecrawl: ${params.url}` }],
                details: { status: "scraping", url: params.url, maxBytes },
            });

            try {
                const requestedUrl = normalizeHttpUrl(params.url);
                const result = await scrapeWithFirecrawl(requestedUrl, signal, dependencies);
                if (signal?.aborted) throw new Error("Crawl cancelled.");
                const fullText = formatCrawlResult(result);
                const formatted = await outputRetention.retain(fullText, {
                    maxBytes,
                    maxLines: DEFAULT_MAX_LINES,
                });
                return {
                    content: [{ type: "text", text: formatted.text }],
                    details: {
                        status: "complete",
                        provider: "firecrawl",
                        requestedUrl: result.requestedUrl,
                        sourceUrl: result.sourceUrl,
                        title: result.title,
                        metadata: result.metadata,
                        maxBytes,
                        contentBytes: Buffer.byteLength(result.content, "utf8"),
                        truncated: formatted.truncated,
                        ...(formatted.fullOutputPath && { fullOutputPath: formatted.fullOutputPath }),
                    },
                };
            } catch (error) {
                const message = signal?.aborted
                    ? "Crawl cancelled."
                    : error instanceof Error
                      ? error.message
                      : String(error);
                throw new Error(`web_crawl failed: ${message}`, { cause: error });
            }
        },
    });
}
