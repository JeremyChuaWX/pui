import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { WebOutputRetention } from "./output-retention.ts";
import { executeWebTool, nonEmptyString, type WebToolDependencies } from "./tool-shell.ts";

const SEARCH_PARAMS = Type.Object({
    query: Type.String({ minLength: 1, description: "Natural-language web search query." }),
});

type SearchParams = Static<typeof SEARCH_PARAMS>;
type CodexModel = Model<"openai-codex-responses">;

type CodexAuth = {
    accessToken: string;
    accountId?: string;
    /** Endpoint derived from the credential source; registry models use their configured base URL. */
    endpoint: string;
    headers?: Record<string, string>;
};

type SearchSource = {
    title: string;
    url: string;
};

type SearchResultItem = SearchSource & {
    refId?: string;
    snippet?: string;
};

type SearchResult = {
    output?: string;
    results: SearchResultItem[];
};

type SearchDetails =
    | { status: "searching" }
    | {
          status: "complete";
          query: string;
          sources: SearchSource[];
          truncated: boolean;
          fullOutputPath?: string;
      };

// The Codex standalone search endpoint executes searches server-side and returns structured
// results without any model inference, so no input/output tokens are billed for a search.
const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const SEARCH_PAYLOAD_MODEL = "gpt-4o";
const CODEX_USER_AGENT = "codex-cli/0.147.0-alpha.6.5";
const MAX_RESULTS = 10;

function resolveCodexSearchUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/alpha/search")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/alpha/search`;
    return `${normalized}/codex/alpha/search`;
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

function isCodexModel(model: Model<Api>): model is CodexModel {
    return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function resolveCodexModel(
    ctx: ExtensionContext,
    environment: Record<string, string | undefined>,
): CodexModel | undefined {
    const configured = environment.WEB_SEARCH_MODEL?.trim();
    if (configured) {
        const slash = configured.indexOf("/");
        if (slash < 1 || slash === configured.length - 1) {
            throw new Error("WEB_SEARCH_MODEL must use provider/model format.");
        }
        const model = ctx.modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1));
        if (!model) throw new Error(`WEB_SEARCH_MODEL ${configured} is not registered in pi.`);
        if (!isCodexModel(model)) {
            throw new Error(
                `${model.provider}/${model.id} cannot authenticate Codex web search. Set WEB_SEARCH_MODEL to a ChatGPT/Codex model.`,
            );
        }
        return model;
    }
    return ctx.model && isCodexModel(ctx.model) ? ctx.model : undefined;
}

function authFromFile(path: string): CodexAuth | undefined {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const accessToken = nonEmptyString(parsed?.tokens?.access_token);
        if (!accessToken) return undefined;
        return {
            accessToken,
            accountId: nonEmptyString(parsed?.tokens?.account_id) ?? extractChatGptAccountId(accessToken),
            endpoint: DEFAULT_ENDPOINT,
        };
    } catch {
        return undefined;
    }
}

/**
 * Resolves ChatGPT/Codex credentials for the standalone search endpoint.
 *
 * Order: explicit `CODEX_ACCESS_TOKEN` environment override, then a pi-registered ChatGPT/Codex
 * model (the active model, or `WEB_SEARCH_MODEL`), then the Codex CLI login at `~/.codex/auth.json`.
 */
async function resolveCodexAuth(
    ctx: ExtensionContext,
    environment: Record<string, string | undefined>,
    codexAuthPath: string | undefined,
): Promise<CodexAuth> {
    const envToken = nonEmptyString(environment.CODEX_ACCESS_TOKEN);
    if (envToken) {
        return {
            accessToken: envToken,
            accountId: nonEmptyString(environment.CODEX_ACCOUNT_ID) ?? extractChatGptAccountId(envToken),
            endpoint: DEFAULT_ENDPOINT,
        };
    }

    const model = resolveCodexModel(ctx, environment);
    if (model) {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(auth.error);
        if (!auth.apiKey) throw new Error(`No API key is available for ${model.provider}/${model.id}.`);
        return {
            accessToken: auth.apiKey,
            accountId: extractChatGptAccountId(auth.apiKey),
            endpoint: resolveCodexSearchUrl(model.baseUrl),
            headers: { ...model.headers, ...auth.headers },
        };
    }

    const fileAuth = authFromFile(codexAuthPath ?? join(homedir(), ".codex", "auth.json"));
    if (fileAuth) return fileAuth;

    throw new Error(
        "No ChatGPT/Codex credentials found for web_search. Sign in to a ChatGPT/Codex model in pi, set CODEX_ACCESS_TOKEN, or run `codex login`.",
    );
}

function normalizeResults(raw: unknown): SearchResultItem[] {
    if (!Array.isArray(raw)) return [];
    const results: SearchResultItem[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const entry = item as Record<string, unknown>;
        const url = nonEmptyString(entry.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({
            title: nonEmptyString(entry.title) ?? url,
            url,
            refId: nonEmptyString(entry.ref_id),
            snippet: nonEmptyString(entry.snippet),
        });
        if (results.length >= MAX_RESULTS) break;
    }
    return results;
}

/**
 * Rewrites Codex citation markers into plain numeric references.
 *
 * The endpoint's `output` text embeds private-Unicode markers (`citeturn0search0`)
 * and bracketed turn references (`[turn0search0]`); both map to `[n]` entries in the source list.
 */
function cleanCitationMarkers(text: string, results: SearchResultItem[]): string {
    const refIndex = new Map<string, number>();
    results.forEach((result, index) => {
        if (result.refId) refIndex.set(result.refId, index + 1);
    });
    const label = (ref: string): string => {
        const num = refIndex.get(ref);
        return num ? `[${num}]` : `[${ref}]`;
    };

    return text
        .replace(
            /[\uE000-\uE2FF]?cite[\uE000-\uE2FF]?([^\uE000-\uE2FF\r\n]+)[\uE000-\uE2FF]?/gi,
            (_match, inner: string) => {
                const ref = inner.trim();
                if (!ref) return "";
                if (ref.includes("†")) {
                    const suffix = ref.split("†").slice(1).join("†").trim();
                    return suffix ? `[${suffix}]` : "";
                }
                return label(ref);
            },
        )
        .replace(/\[(turn\d+[a-z0-9_,\s]*)\]/gi, (_match, inner: string) =>
            inner
                .split(",")
                .map((ref) => label(ref.trim()))
                .join(" "),
        );
}

async function runSearch(
    params: SearchParams,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    dependencies: WebToolDependencies,
    sessionId: string,
): Promise<SearchResult> {
    const environment = dependencies.environment ?? process.env;
    const auth = await resolveCodexAuth(ctx, environment, dependencies.codexAuthPath);

    const headers: Record<string, string> = {
        ...auth.headers,
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    headers["User-Agent"] = headers["User-Agent"] ?? CODEX_USER_AGENT;
    if (auth.accountId) headers["ChatGPT-Account-ID"] = headers["ChatGPT-Account-ID"] ?? auth.accountId;

    const body = {
        id: sessionId,
        model: SEARCH_PAYLOAD_MODEL,
        commands: { search_query: [{ q: params.query }] },
    };

    const response = await (dependencies.fetch ?? globalThis.fetch)(auth.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
        throw new Error(
            "Codex web search authentication was rejected. Re-authenticate the ChatGPT/Codex model in pi, refresh CODEX_ACCESS_TOKEN, or run `codex login`.",
        );
    }
    if (response.status === 429) throw new Error("Codex web search is rate limited; retry later.");
    if (!response.ok) throw new Error(`Codex web search returned HTTP ${response.status}: ${text.slice(0, 700)}`);

    let payload: Record<string, unknown>;
    try {
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
        throw new Error(`Codex web search returned invalid JSON: ${text.slice(0, 700)}`);
    }

    const results = normalizeResults(payload.results);
    const output = nonEmptyString(payload.output);
    return { output: output ? cleanCitationMarkers(output, results) : undefined, results };
}

function formatSearchResult(query: string, result: SearchResult): string {
    if (!result.output && result.results.length === 0) {
        return `No web search results returned for ${JSON.stringify(query)}.`;
    }
    return [
        `Web search results for ${JSON.stringify(query)}:`,
        ...(result.output ? ["", result.output] : []),
        "",
        result.results.length ? "Sources:" : "Sources: none returned by provider",
        ...result.results.map((source, index) =>
            [
                `${index + 1}. ${source.title}`,
                `   ${source.url}`,
                ...(source.snippet ? [`   ${source.snippet}`] : []),
            ].join("\n"),
        ),
    ].join("\n");
}

export default function webSearchExtension(
    pi: ExtensionAPI,
    dependencies: WebToolDependencies,
    outputRetention: WebOutputRetention,
) {
    const newSessionId = () => `search_session_${Math.random().toString(36).slice(2, 10)}`;
    let sessionId = newSessionId();
    pi.on("session_start", () => {
        sessionId = newSessionId();
    });
    pi.registerTool<typeof SEARCH_PARAMS, SearchDetails>({
        name: "web_search",
        label: "Web Search",
        description:
            "Search the live web through the Codex standalone search endpoint using a natural-language query. Returns ranked results with snippets without spending model inference tokens. Output is capped at 50KB.",
        promptSnippet: "Search the web with Codex standalone search using a natural-language query.",
        promptGuidelines: [
            "Use web_search when an answer depends on current, external, or recently changed information.",
            "Use web_search for discovery; use web_crawl when a specific URL must be extracted.",
            "When using web_search, cite the returned source URLs in the final answer.",
            "web_search authenticates with ChatGPT/Codex credentials: the active Codex model, WEB_SEARCH_MODEL, CODEX_ACCESS_TOKEN, or `codex login`.",
        ],
        parameters: SEARCH_PARAMS,
        execute(_toolCallId, params, signal, onUpdate, ctx) {
            return executeWebTool({
                toolName: "web_search",
                cancelledMessage: "Search cancelled.",
                outputRetention,
                signal,
                onUpdate,
                starting: { text: `Searching the web for: ${params.query}`, details: { status: "searching" } },
                limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
                async run() {
                    const result = await runSearch(params, ctx, signal, dependencies, sessionId);
                    return {
                        fullText: formatSearchResult(params.query, result),
                        details: {
                            status: "complete" as const,
                            query: params.query,
                            sources: result.results.map(({ title, url }) => ({ title, url })),
                        },
                    };
                },
            });
        },
    });
}
