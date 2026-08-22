import { afterEach, describe, expect, test } from "bun:test";
import { createExtensionApiHarness, type ExtensionApiHarness } from "#test-support/extension-api.ts";
import { registerWebExtension } from "./pi.ts";

const shutdownHosts = new Set<ExtensionApiHarness>();

function host(dependencies: Parameters<typeof registerWebExtension>[1]) {
    const harness = createExtensionApiHarness();
    registerWebExtension(harness.api, dependencies);
    shutdownHosts.add(harness);
    return (name: string) => harness.tool(name);
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

afterEach(async () => {
    const hosts = [...shutdownHosts];
    shutdownHosts.clear();
    await Promise.allSettled(
        hosts.map((host) =>
            host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {} as never),
        ),
    );
});

const codex = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "codex",
    baseUrl: "https://chatgpt.test/backend-api",
};
const anthropic = {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude",
    baseUrl: "https://example.test",
};
const codexToken = [
    "e30",
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString(
        "base64url",
    ),
    "sig",
].join(".");

describe("web_search", () => {
    test("sends a standalone search command with registry Codex credentials", async () => {
        let request: any;
        const tool = host({
            environment: {},
            fetch: async (url, init) => {
                request = { url, init, body: JSON.parse(String(init?.body)) };
                return new Response(
                    JSON.stringify({
                        results: [
                            { title: "One", url: "https://one.test", ref_id: "turn0search0", snippet: "First hit" },
                            { title: "Duplicate", url: "https://one.test" },
                            { url: "https://two.test" },
                        ],
                    }),
                );
            },
        })("web_search");

        const result = await run(tool, { query: "what changed?" }, context(codex, codexToken));
        expect(request.url).toBe("https://chatgpt.test/backend-api/codex/alpha/search");
        expect(request.body.model).toBe("gpt-4o");
        expect(request.body.commands).toEqual({ search_query: [{ q: "what changed?" }] });
        expect(request.body.id).toStartWith("search_session_");
        expect(request.init.headers.Authorization).toBe(`Bearer ${codexToken}`);
        expect(request.init.headers["User-Agent"]).toStartWith("codex-cli/");
        expect(request.init.headers["ChatGPT-Account-ID"]).toBe("acct-123");
        expect(result.details.sources).toEqual([
            { title: "One", url: "https://one.test" },
            { title: "https://two.test", url: "https://two.test" },
        ]);
        expect(result.content[0].text).toContain("First hit");
    });

    test("rewrites citation markers and preserves the complete formatted result", async () => {
        const tool = host({
            environment: {},
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        output: "Answer \uE200cite\uE202turn0search0\uE201 and [turn0search0] done",
                        results: [
                            {
                                title: "Source title",
                                url: "https://source.test",
                                ref_id: "turn0search0",
                                snippet: "Snip",
                            },
                        ],
                    }),
                ),
        })("web_search");

        const result = await run(tool, { query: "format me" }, context(codex, codexToken));
        expect(result.content[0].text).toBe(
            [
                'Web search results for "format me":',
                "",
                "Answer [1] and [1] done",
                "",
                "Sources:",
                "1. Source title\n   https://source.test\n   Snip",
            ].join("\n"),
        );
    });

    test("prefers CODEX_ACCESS_TOKEN over the model registry", async () => {
        let request: any;
        const tool = host({
            environment: { CODEX_ACCESS_TOKEN: "env-token", CODEX_ACCOUNT_ID: "env-acct" },
            fetch: async (url, init) => {
                request = { url, init };
                return new Response(JSON.stringify({ results: [] }));
            },
        })("web_search");

        const result = await run(tool, { query: "anything" }, context(anthropic));
        expect(request.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
        expect(request.init.headers.Authorization).toBe("Bearer env-token");
        expect(request.init.headers["ChatGPT-Account-ID"]).toBe("env-acct");
        expect(result.content[0].text).toBe('No web search results returned for "anything".');
    });

    test("selects the WEB_SEARCH_MODEL credentials when the active model is not Codex", async () => {
        let request: any;
        const tool = host({
            environment: { WEB_SEARCH_MODEL: "openai-codex/codex" },
            fetch: async (url, init) => {
                request = { url, init };
                return new Response(JSON.stringify({ results: [{ title: "Hit", url: "https://hit.test" }] }));
            },
        })("web_search");
        const ctx = {
            model: anthropic,
            modelRegistry: {
                find: (provider: string, id: string) =>
                    provider === "openai-codex" && id === "codex" ? codex : undefined,
                getApiKeyAndHeaders: async () => ({ ok: true, apiKey: codexToken, headers: {} }),
            },
        } as any;

        const result = await run(tool, { query: "news" }, ctx);
        expect(request.url).toBe("https://chatgpt.test/backend-api/codex/alpha/search");
        expect(result.details.sources).toEqual([{ title: "Hit", url: "https://hit.test" }]);
    });

    test("reads Codex CLI credentials from auth.json as a fallback", async () => {
        const { mkdtempSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const authPath = join(mkdtempSync(join(tmpdir(), "pui-web-test-")), "auth.json");
        writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "file-token", account_id: "file-acct" } }));

        let request: any;
        const tool = host({
            environment: {},
            codexAuthPath: authPath,
            fetch: async (url, init) => {
                request = { url, init };
                return new Response(JSON.stringify({ results: [] }));
            },
        })("web_search");

        await run(tool, { query: "x" }, context(anthropic));
        expect(request.init.headers.Authorization).toBe("Bearer file-token");
        expect(request.init.headers["ChatGPT-Account-ID"]).toBe("file-acct");
    });

    test("reports missing credentials, rejected auth, and cancellation", async () => {
        let calls = 0;
        const missing = host({
            environment: {},
            codexAuthPath: "/nonexistent/pui-web-test/auth.json",
            fetch: async () => {
                calls++;
                return new Response();
            },
        })("web_search");
        await expect(run(missing, { query: "x" }, context(anthropic))).rejects.toThrow(
            "No ChatGPT/Codex credentials found",
        );
        expect(calls).toBe(0);

        const rejected = host({
            environment: {},
            fetch: async () => new Response("denied", { status: 401 }),
        })("web_search");
        await expect(run(rejected, { query: "x" }, context(codex, codexToken))).rejects.toThrow(
            "authentication was rejected",
        );

        const cancelled = host({
            environment: {},
            fetch: async () => new Response(JSON.stringify({ results: [] })),
        })("web_search");
        const controller = new AbortController();
        controller.abort();
        await expect(run(cancelled, { query: "x" }, context(codex, codexToken), controller.signal)).rejects.toThrow(
            "web_search failed: Search cancelled.",
        );
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

    test("preserves the complete formatted crawl result when it fits", async () => {
        const tool = host({
            environment: { FIRECRAWL_API_KEY: "fire" },
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        data: {
                            markdown: "# Complete page",
                            metadata: { title: "Complete", sourceURL: "https://canonical.test/complete" },
                        },
                    }),
                ),
        })("web_crawl");

        const result = await run(tool, { url: "https://example.test/complete", max_bytes: 1_000 });
        expect(result.details.maxBytes).toBe(1_000);
        expect(result.content[0].text).toBe(
            [
                "Web crawl result for https://example.test/complete:",
                "Provider: Firecrawl",
                "Title: Complete",
                "Source URL: https://canonical.test/complete",
                "",
                "Content:",
                "# Complete page",
            ].join("\n"),
        );
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

    test("surfaces Firecrawl errors and cancellation", async () => {
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
    });
});
