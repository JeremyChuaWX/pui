import { describe, expect, test } from "bun:test";
import { registerWebExtension } from "./index.ts";

function host(dependencies: Parameters<typeof registerWebExtension>[1]) {
    const tools = new Map<string, any>();
    registerWebExtension(
        {
            registerTool(tool: any) {
                tools.set(tool.name, tool);
            },
        } as any,
        dependencies,
    );
    return (name: string) => tools.get(name);
}

function context(model: any, apiKey = "secret") {
    return {
        model,
        modelRegistry: {
            find(provider: string, id: string) {
                return provider === model.provider && id === model.id ? model : undefined;
            },
            async getApiKeyAndHeaders() {
                return { ok: true, apiKey, headers: {} };
            },
        },
    } as any;
}

function run(tool: any, params: any, ctx: any = {}, signal?: AbortSignal) {
    return tool.execute("call", params, signal, undefined, ctx);
}

const openai = { provider: "openai", api: "openai-responses", id: "gpt-5", baseUrl: "https://api.openai.test/v1" };

describe("web_search", () => {
    test("uses Responses search and extracts citations before search sources", async () => {
        let request: any;
        const tool = host({
            environment: {},
            fetch: async (url, init) => {
                request = { url, init, body: JSON.parse(String(init?.body)) };
                return new Response(
                    JSON.stringify({
                        output: [
                            {
                                type: "message",
                                content: [
                                    {
                                        type: "output_text",
                                        text: "Current answer",
                                        annotations: [
                                            { type: "url_citation", title: "Citation", url: "https://one.test" },
                                        ],
                                    },
                                ],
                            },
                            {
                                type: "web_search_call",
                                action: {
                                    type: "search",
                                    sources: [
                                        { title: "Duplicate", url: "https://one.test" },
                                        { title: "Two", url: "https://two.test" },
                                    ],
                                },
                            },
                        ],
                    }),
                );
            },
        })("web_search");

        const result = await run(tool, { query: "what changed?" }, context(openai));
        expect(request.url).toBe("https://api.openai.test/v1/responses");
        expect(request.body.tools).toEqual([{ type: "web_search" }]);
        expect(request.init.headers.Authorization).toBe("Bearer secret");
        expect(result.details.sources).toEqual([
            { title: "Citation", url: "https://one.test" },
            { title: "Two", url: "https://two.test" },
        ]);
        expect(result.content[0].text).toContain("Current answer");
    });

    test("supports configured Codex models and SSE responses", async () => {
        const codex = {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "codex",
            baseUrl: "https://chatgpt.test/backend-api",
        };
        let request: any;
        const tool = host({
            environment: { WEB_SEARCH_MODEL: "openai-codex/codex" },
            fetch: async (url, init) => {
                request = { url, init, body: JSON.parse(String(init?.body)) };
                const stream = [
                    'event: response.output_text.delta\ndata: {"delta":"Streamed answer"}',
                    'event: response.completed\ndata: {"response":{"output":[{"type":"web_search_call","action":{"type":"search","sources":[{"title":"Source","url":"https://source.test"}]}}]}}',
                ].join("\n\n");
                return new Response(stream);
            },
        })("web_search");
        const result = await run(tool, { query: "news" }, context(codex));
        expect(request.url).toBe("https://chatgpt.test/backend-api/codex/responses");
        expect(request.body.stream).toBe(true);
        expect(request.body.max_output_tokens).toBeUndefined();
        expect(request.init.headers.Accept).toBe("text/event-stream");
        expect(result.content[0].text).toContain("Streamed answer");
        expect(result.details.sources[0].url).toBe("https://source.test");
    });

    test("reports unsupported configuration and cancellation", async () => {
        const unsupported = {
            provider: "anthropic",
            api: "anthropic-messages",
            id: "claude",
            baseUrl: "https://example.test",
        };
        const tool = host({
            environment: {},
            fetch: async () => {
                throw new Error("should not fetch");
            },
        })("web_search");
        await expect(run(tool, { query: "x" }, context(unsupported))).rejects.toThrow(
            "does not support GPT built-in web search",
        );

        const controller = new AbortController();
        controller.abort();
        await expect(run(tool, { query: "x" }, context(openai), controller.signal)).rejects.toThrow(
            "web_search failed: Search cancelled.",
        );
    });

    test("truncates oversized answers and records the full output", async () => {
        const tool = host({
            environment: {},
            fetch: async () => new Response(JSON.stringify({ output_text: "x".repeat(60_000) })),
        })("web_search");
        const result = await run(tool, { query: "large" }, context(openai));
        expect(result.details.truncated).toBe(true);
        expect(result.details.fullOutputPath).toEndWith("result.md");
        expect(result.content[0].text).toContain("Output truncated");
    });
});

describe("web_crawl", () => {
    test("uses Firecrawl configuration and returns normalized metadata", async () => {
        let request: any;
        const tool = host({
            environment: { FIRECRAWL_API_KEY: "fire", FIRECRAWL_API_URL: "https://fire.test/v2" },
            fetch: async (url, init) => {
                request = { url, init, body: JSON.parse(String(init?.body)) };
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: {
                            markdown: "# Page",
                            metadata: { title: "Page", sourceURL: "https://canonical.test/page" },
                        },
                    }),
                );
            },
        })("web_crawl");
        const result = await run(tool, { url: "https://example.test/page" });
        expect(request.url).toBe("https://fire.test/v2/scrape");
        expect(request.init.headers.Authorization).toBe("Bearer fire");
        expect(request.body).toEqual({
            url: "https://example.test/page",
            formats: ["markdown"],
            onlyMainContent: true,
        });
        expect(result.details.sourceUrl).toBe("https://canonical.test/page");
        expect(result.content[0].text).toContain("# Page");
    });

    test("validates URL and required configuration without calling the API", async () => {
        let calls = 0;
        const tool = host({
            environment: {},
            fetch: async () => {
                calls++;
                return new Response();
            },
        })("web_crawl");
        await expect(run(tool, { url: "file:///etc/passwd" })).rejects.toThrow("only accepts HTTP(S) URLs");
        await expect(run(tool, { url: "https://user:pass@example.test" })).rejects.toThrow(
            "does not accept URLs containing credentials",
        );
        await expect(run(tool, { url: "https://example.test" })).rejects.toThrow("FIRECRAWL_API_KEY is not set");
        expect(calls).toBe(0);
    });

    test("surfaces Firecrawl errors, cancellation, and truncates to max_bytes", async () => {
        const failed = host({
            environment: { FIRECRAWL_API_KEY: "x" },
            fetch: async () => new Response(JSON.stringify({ success: false, error: "blocked" }), { status: 403 }),
        })("web_crawl");
        await expect(run(failed, { url: "https://example.test" })).rejects.toThrow("HTTP 403: blocked");

        const controller = new AbortController();
        controller.abort();
        await expect(run(failed, { url: "https://example.test" }, {}, controller.signal)).rejects.toThrow(
            "web_crawl failed: Crawl cancelled.",
        );

        const large = host({
            environment: { FIRECRAWL_API_KEY: "x" },
            fetch: async () => new Response(JSON.stringify({ data: { markdown: "content ".repeat(100) } })),
        })("web_crawl");
        const result = await run(large, { url: "https://example.test", max_bytes: 100 });
        expect(result.details.maxBytes).toBe(100);
        expect(result.details.truncated).toBe(true);
        expect(result.content[0].text).toContain("Output truncated");
    });
});
