import type { Api, Model } from "@earendil-works/pi-ai";
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { WebOutputRetentionAdapter } from "./output-retention.ts";

const SEARCH_PARAMS = Type.Object({
    query: Type.String({ minLength: 1, description: "Natural-language web search query." }),
});

type SearchParams = Static<typeof SEARCH_PARAMS>;
type SearchProvider = "openai" | "chatgpt";
type SearchModel = Model<"openai-responses" | "openai-codex-responses">;

type SearchSource = {
    title: string;
    url: string;
};

type SearchResult = {
    provider: SearchProvider;
    model: string;
    answer: string;
    sources: SearchSource[];
};

type SearchDetails =
    | { status: "searching" }
    | {
          status: "complete";
          provider: SearchProvider;
          model: string;
          query: string;
          sources: SearchSource[];
          truncated: boolean;
          fullOutputPath?: string;
      };

type ResponseOutputItem = {
    type?: string;
    action?: {
        type?: string;
        sources?: Array<{ title?: unknown; url?: unknown }>;
    };
    content?: Array<{
        type?: string;
        text?: unknown;
        annotations?: Array<{ type?: string; title?: unknown; url?: unknown }>;
    }>;
};

type ResponsePayload = {
    output_text?: unknown;
    output?: ResponseOutputItem[];
};

type SseData = {
    type?: unknown;
    delta?: unknown;
    item?: ResponseOutputItem;
    response?: ResponsePayload;
};

const SEARCH_INSTRUCTIONS =
    "Use web search to answer the query. Return concise, useful findings grounded in current sources. Do not invent facts or URLs.";
const MAX_OUTPUT_TOKENS = 8000;
const MAX_SOURCES = 10;
const CHATGPT_USER_AGENT = "pi-web-search";

export type WebSearchDependencies = {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    environment?: Record<string, string | undefined>;
};

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEndpoint(baseUrl: string, suffix: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function resolveCodexResponsesUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
}

function extractChatGptAccountId(token: string): string | undefined {
    try {
        const payload = token.split(".")[1];
        if (!payload) return undefined;
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
        return nonEmptyString(decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id);
    } catch {
        return undefined;
    }
}

function searchProvider(model: Model<Api>): SearchProvider | undefined {
    if (model.provider === "openai" && model.api === "openai-responses") return "openai";
    if (model.provider === "openai-codex" && model.api === "openai-codex-responses") return "chatgpt";
    return undefined;
}

function resolveSearchModel(ctx: ExtensionContext, environment: Record<string, string | undefined>): SearchModel {
    const configured = environment.WEB_SEARCH_MODEL?.trim();
    let model: Model<Api> | undefined;

    if (configured) {
        const slash = configured.indexOf("/");
        if (slash < 1 || slash === configured.length - 1) {
            throw new Error("WEB_SEARCH_MODEL must use provider/model format.");
        }
        model = ctx.modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1));
        if (!model) throw new Error(`WEB_SEARCH_MODEL ${configured} is not registered in pi.`);
    } else {
        model = ctx.model;
    }

    if (!model) throw new Error("No active pi model is available for web_search.");
    if (!searchProvider(model)) {
        throw new Error(
            `${model.provider}/${model.id} does not support GPT built-in web search. Select an OpenAI Responses or ChatGPT/Codex model, or set WEB_SEARCH_MODEL=provider/model.`,
        );
    }
    return model as SearchModel;
}

function addSource(sources: SearchSource[], seen: Set<string>, title: unknown, url: unknown): void {
    const resolvedUrl = nonEmptyString(url);
    if (!resolvedUrl || seen.has(resolvedUrl)) return;
    seen.add(resolvedUrl);
    sources.push({ title: nonEmptyString(title) ?? resolvedUrl, url: resolvedUrl });
}

function collectResponseText(payload: ResponsePayload | undefined): string {
    const direct = nonEmptyString(payload?.output_text);
    if (direct) return direct;

    const parts: string[] = [];
    for (const item of payload?.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
            const text = nonEmptyString(part.text);
            if (part.type === "output_text" && text) parts.push(text);
        }
    }
    return parts.join("\n\n");
}

function collectResponseSources(output: ResponseOutputItem[] | undefined): SearchSource[] {
    const sources: SearchSource[] = [];
    const seen = new Set<string>();

    // Put explicit citations first so the bounded source list preserves links used by the answer.
    for (const item of output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
            for (const annotation of part.annotations ?? []) {
                if (annotation.type === "url_citation") addSource(sources, seen, annotation.title, annotation.url);
            }
        }
    }

    for (const item of output ?? []) {
        if (item.type !== "web_search_call" || item.action?.type !== "search") continue;
        for (const source of item.action.sources ?? []) addSource(sources, seen, source.title, source.url);
    }

    return sources;
}

function parseJsonResponse(text: string): ResponsePayload {
    try {
        return text ? (JSON.parse(text) as ResponsePayload) : {};
    } catch {
        throw new Error(`GPT web search returned invalid JSON: ${text.slice(0, 700)}`);
    }
}

function parseSseEvents(text: string): Array<{ event: string; data: SseData }> {
    const events: Array<{ event: string; data: SseData }> = [];
    for (const block of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
        const lines = block.split("\n");
        const eventHeader = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
        const dataText = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
        if (!dataText || dataText === "[DONE]") continue;
        try {
            const data = JSON.parse(dataText) as SseData;
            const event = eventHeader || nonEmptyString(data.type);
            if (event) events.push({ event, data });
        } catch {
            // Ignore malformed or incomplete event fragments.
        }
    }
    return events;
}

function parseChatGptResponse(text: string): { answer: string; sources: SearchSource[] } {
    let streamedAnswer = "";
    let finalResponse: ResponsePayload | undefined;
    const streamedSources: SearchSource[] = [];
    const streamedSeen = new Set<string>();

    for (const { event, data } of parseSseEvents(text)) {
        if (event === "response.output_text.delta" && typeof data.delta === "string") streamedAnswer += data.delta;
        if (data.response?.output) finalResponse = data.response;
        if (data.item?.type === "web_search_call" && data.item.action?.type === "search") {
            for (const source of data.item.action.sources ?? []) {
                addSource(streamedSources, streamedSeen, source.title, source.url);
            }
        }
    }

    const sources = collectResponseSources(finalResponse?.output);
    const seen = new Set(sources.map((source) => source.url));
    for (const source of streamedSources) addSource(sources, seen, source.title, source.url);

    return {
        answer: streamedAnswer.trim() || collectResponseText(finalResponse),
        sources,
    };
}

async function runSearch(
    params: SearchParams,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    dependencies: WebSearchDependencies,
): Promise<SearchResult> {
    const model = resolveSearchModel(ctx, dependencies.environment ?? process.env);
    const provider = searchProvider(model);
    if (!provider) throw new Error(`${model.provider}/${model.id} does not support GPT built-in web search.`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    if (!auth.apiKey) throw new Error(`No API key is available for ${model.provider}/${model.id}.`);

    const headers: Record<string, string> = {
        ...model.headers,
        ...auth.headers,
        Authorization: `Bearer ${auth.apiKey}`,
        "Content-Type": "application/json",
    };
    const body: Record<string, unknown> = {
        include: ["web_search_call.action.sources"],
        input: params.query,
        instructions: SEARCH_INSTRUCTIONS,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        model: model.id,
        store: false,
        tool_choice: "required",
        tools: [{ type: "web_search" }],
    };
    let endpoint = normalizeEndpoint(model.baseUrl, "/responses");

    if (provider === "chatgpt") {
        endpoint = resolveCodexResponsesUrl(model.baseUrl);
        const accountId = extractChatGptAccountId(auth.apiKey);
        if (accountId) headers["chatgpt-account-id"] = accountId;
        headers.Accept = headers.Accept ?? headers.accept ?? "text/event-stream";
        headers["User-Agent"] = headers["User-Agent"] ?? CHATGPT_USER_AGENT;
        delete headers.accept;
        delete body.max_output_tokens;
        body.input = [{ role: "user", content: [{ type: "input_text", text: params.query }] }];
        body.stream = true;
    }

    const response = await (dependencies.fetch ?? globalThis.fetch)(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${provider} web search returned HTTP ${response.status}: ${text.slice(0, 700)}`);

    const parsed =
        provider === "chatgpt"
            ? parseChatGptResponse(text)
            : (() => {
                  const payload = parseJsonResponse(text);
                  return { answer: collectResponseText(payload), sources: collectResponseSources(payload.output) };
              })();

    if (!parsed.answer) throw new Error("GPT web search returned an empty answer.");
    return {
        provider,
        model: `${model.provider}/${model.id}`,
        answer: parsed.answer,
        sources: parsed.sources.slice(0, MAX_SOURCES),
    };
}

function formatSearchResult(query: string, result: SearchResult): string {
    return [
        `Web search findings for ${JSON.stringify(query)}:`,
        `Provider: ${result.provider}; model: ${result.model}`,
        "",
        result.answer,
        "",
        result.sources.length ? "Sources:" : "Sources: none returned by provider",
        ...result.sources.map((source, index) => `${index + 1}. ${source.title}\n   ${source.url}`),
    ].join("\n");
}

export default function webSearchExtension(
    pi: ExtensionAPI,
    dependencies: WebSearchDependencies,
    getOutputRetention: () => WebOutputRetentionAdapter,
) {
    pi.registerTool<typeof SEARCH_PARAMS, SearchDetails>({
        name: "web_search",
        label: "Web Search",
        description:
            "Search the live web with GPT's built-in web search using a natural-language query. Returns a concise answer and provider source URLs. Output is capped at 50KB.",
        promptSnippet: "Search the web with GPT built-in web search using a natural-language query.",
        promptGuidelines: [
            "Use web_search when an answer depends on current, external, or recently changed information.",
            "Use web_search for discovery; use web_crawl when a specific URL must be extracted.",
            "When using web_search, cite the returned source URLs in the final answer.",
            "Set WEB_SEARCH_MODEL=provider/model when the active model is not an OpenAI Responses or ChatGPT/Codex model.",
        ],
        parameters: SEARCH_PARAMS,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const outputRetention = getOutputRetention();
            onUpdate?.({
                content: [{ type: "text", text: `Searching the web for: ${params.query}` }],
                details: { status: "searching" },
            });

            try {
                const result = await runSearch(params, ctx, signal, dependencies);
                if (signal?.aborted) throw new Error("Search cancelled.");
                const fullText = formatSearchResult(params.query, result);
                const formatted = await outputRetention.retain(fullText, {
                    maxBytes: DEFAULT_MAX_BYTES,
                    maxLines: DEFAULT_MAX_LINES,
                });
                return {
                    content: [{ type: "text", text: formatted.text }],
                    details: {
                        status: "complete",
                        provider: result.provider,
                        model: result.model,
                        query: params.query,
                        sources: result.sources,
                        truncated: formatted.truncated,
                        ...(formatted.fullOutputPath && { fullOutputPath: formatted.fullOutputPath }),
                    },
                };
            } catch (error) {
                const message = signal?.aborted
                    ? "Search cancelled."
                    : error instanceof Error
                      ? error.message
                      : String(error);
                throw new Error(`web_search failed: ${message}`, { cause: error });
            }
        },
    });
}
