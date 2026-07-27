import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { registerWebExtension } from "./index.ts";
import { WebOutputRetention, type WebOutputRetentionFileSystem } from "./output-retention.ts";
import { lineCount, waitUntil } from "./test-utils.ts";

const shutdownHandlers = new Set<() => Promise<void>>();

function host(dependencies: Parameters<typeof registerWebExtension>[1]) {
    const tools = new Map<string, any>();
    const handlers = new Map<string, () => Promise<void>>();
    registerWebExtension(
        {
            registerTool(tool: any) {
                tools.set(tool.name, tool);
            },
            on(event: string, handler: () => Promise<void>) {
                handlers.set(event, handler);
                if (event === "session_shutdown") shutdownHandlers.add(handler);
            },
        } as any,
        dependencies,
    );
    const registeredTool = (name: string) => tools.get(name);
    registeredTool.handler = (event: string) => handlers.get(event);
    return registeredTool;
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
    const handlers = [...shutdownHandlers];
    shutdownHandlers.clear();
    await Promise.allSettled(handlers.map((handler) => handler()));
});

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

    test("preserves the complete formatted search result when it fits", async () => {
        const tool = host({
            environment: {},
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        output: [
                            {
                                type: "message",
                                content: [
                                    {
                                        type: "output_text",
                                        text: "Formatted answer",
                                        annotations: [
                                            { type: "url_citation", title: "Source title", url: "https://source.test" },
                                        ],
                                    },
                                ],
                            },
                        ],
                    }),
                ),
        })("web_search");

        const result = await run(tool, { query: "format me" }, context(openai));
        expect(result.content[0].text).toBe(
            [
                'Web search findings for "format me":',
                "Provider: openai; model: openai/gpt-5",
                "",
                "Formatted answer",
                "",
                "Sources:",
                "1. Source title\n   https://source.test",
            ].join("\n"),
        );
        expect(result.details.truncated).toBe(false);
        expect("fullOutputPath" in result.details).toBe(false);
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

    test("truncates oversized answers and retains the exact complete formatted output", async () => {
        const answer = "x".repeat(60_000);
        const tool = host({
            environment: {},
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        output: [
                            {
                                type: "message",
                                content: [
                                    {
                                        type: "output_text",
                                        text: answer,
                                        annotations: [
                                            { type: "url_citation", title: "Large source", url: "https://large.test" },
                                        ],
                                    },
                                ],
                            },
                        ],
                    }),
                ),
        })("web_search");
        const result = await run(tool, { query: "large" }, context(openai));
        const expected = [
            'Web search findings for "large":',
            "Provider: openai; model: openai/gpt-5",
            "",
            answer,
            "",
            "Sources:",
            "1. Large source\n   https://large.test",
        ].join("\n");

        expect(result.details.truncated).toBe(true);
        expect(result.details.fullOutputPath).toEndWith("result.md");
        expect(result.content[0].text).toContain("Output truncated");
        expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
        expect(await readFile(result.details.fullOutputPath, "utf8")).toBe(expected);
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

        const result = await run(tool, { url: "https://example.test/complete" });
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
        expect(result.details.truncated).toBe(false);
        expect("fullOutputPath" in result.details).toBe(false);
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

        const content = "content ".repeat(100);
        const large = host({
            environment: { FIRECRAWL_API_KEY: "x" },
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        data: {
                            markdown: content,
                            metadata: { title: "Large page", sourceURL: "https://canonical.test/large" },
                        },
                    }),
                ),
        })("web_crawl");
        const result = await run(large, { url: "https://example.test", max_bytes: 100 });
        expect(result.details.maxBytes).toBe(100);
        expect(result.details.truncated).toBe(true);
        expect(result.content[0].text).toContain("Output truncated");
        expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(100);
        expect(lineCount(result.content[0].text)).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
        expect(await readFile(result.details.fullOutputPath, "utf8")).toBe(
            [
                "Web crawl result for https://example.test/:",
                "Provider: Firecrawl",
                "Title: Large page",
                "Source URL: https://canonical.test/large",
                "",
                "Content:",
                content.trim(),
            ].join("\n"),
        );
    });
});

describe("web output retention integration", () => {
    test("shares one session quota owner between search and crawl", async () => {
        const answer = "s".repeat(60_000);
        const expectedSearchOutput = [
            'Web search findings for "quota":',
            "Provider: openai; model: openai/gpt-5",
            "",
            answer,
            "",
            "Sources: none returned by provider",
        ].join("\n");
        const outputRetention = new WebOutputRetention({
            maxRetainedResultBytes: 70_000,
            maxRetainedSessionBytes: Buffer.byteLength(expectedSearchOutput),
        });
        const registered = host({
            createOutputRetention: () => outputRetention,
            environment: { FIRECRAWL_API_KEY: "fire" },
            fetch: async (url) =>
                String(url).includes("/responses")
                    ? new Response(JSON.stringify({ output_text: answer }))
                    : new Response(JSON.stringify({ data: { markdown: "crawl ".repeat(200) } })),
        });

        const search = await run(registered("web_search"), { query: "quota" }, context(openai));
        const crawl = await run(registered("web_crawl"), { url: "https://example.test", max_bytes: 100 });

        expect(search.details.fullOutputPath).toBeString();
        expect(crawl.details.status).toBe("complete");
        expect(crawl.details.truncated).toBe(true);
        expect("fullOutputPath" in crawl.details).toBe(false);
        expect(crawl.content[0].text).toContain("Output truncated");
    });

    test("session shutdown removes retained output and creates a fresh injected owner", async () => {
        let owners = 0;
        const registered = host({
            createOutputRetention() {
                owners++;
                return new WebOutputRetention();
            },
            environment: { FIRECRAWL_API_KEY: "fire" },
            fetch: async (url) =>
                String(url).includes("/responses")
                    ? new Response(JSON.stringify({ output_text: "s".repeat(60_000) }))
                    : new Response(JSON.stringify({ data: { markdown: "crawl ".repeat(200) } })),
        });
        const search = await run(registered("web_search"), { query: "cleanup" }, context(openai));
        const crawl = await run(registered("web_crawl"), { url: "https://example.test", max_bytes: 100 });
        const paths = [search.details.fullOutputPath, crawl.details.fullOutputPath] as string[];

        expect(owners).toBe(1);
        for (const path of paths) expect(await stat(path)).toBeDefined();
        expect(dirname(paths[0])).not.toBe(dirname(paths[1]));
        await registered.handler("session_shutdown")!();
        for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

        const nextSession = await run(registered("web_search"), { query: "after shutdown" }, context(openai));
        expect(owners).toBe(2);
        expect(nextSession.details.truncated).toBe(true);
        expect(nextSession.details.fullOutputPath).toBeString();
        expect(await stat(nextSession.details.fullOutputPath)).toBeDefined();
    });

    test("retries a retired owner's failed cleanup on a later session shutdown", async () => {
        let directory = 0;
        let removals = 0;
        const removed: string[] = [];
        const fileSystem: WebOutputRetentionFileSystem = {
            async mkdtemp() {
                return `/private/retry-web-output-${++directory}`;
            },
            async chmod() {},
            async writeFile() {},
            async rm(path) {
                removed.push(path);
                if (removals++ === 0) throw new Error("busy");
            },
        };
        const registered = host({
            createOutputRetention: () => new WebOutputRetention({ fileSystem }),
            environment: {},
            fetch: async () => new Response(JSON.stringify({ output_text: "x".repeat(60_000) })),
        });

        await run(registered("web_search"), { query: "first session" }, context(openai));
        await registered.handler("session_shutdown")!();
        await run(registered("web_search"), { query: "second session" }, context(openai));
        await registered.handler("session_shutdown")!();

        expect(removed.filter((path) => path === "/private/retry-web-output-1")).toHaveLength(2);
        expect(removed).toContain("/private/retry-web-output-2");
    });

    test("waits for a write settling during shutdown and leaves no retained directory", async () => {
        let resolveWrite!: () => void;
        const writeGate = new Promise<void>((resolve) => (resolveWrite = resolve));
        const writes: string[] = [];
        const removed: string[] = [];
        const fileSystem: WebOutputRetentionFileSystem = {
            async mkdtemp() {
                return "/private/integration-web-output";
            },
            async chmod() {},
            async writeFile(path) {
                writes.push(path);
                await writeGate;
            },
            async rm(path) {
                removed.push(path);
            },
        };
        const registered = host({
            createOutputRetention: () => new WebOutputRetention({ fileSystem }),
            environment: {},
            fetch: async () => new Response(JSON.stringify({ output_text: "x".repeat(60_000) })),
        });
        const execution = run(registered("web_search"), { query: "race" }, context(openai));
        await waitUntil(() => writes.length === 1);

        let cleanupSettled = false;
        const cleanup = registered.handler("session_shutdown")!().then(() => {
            cleanupSettled = true;
        });
        await Bun.sleep(1);
        const waitedForWrite = !cleanupSettled;
        resolveWrite();
        const result = await execution;
        await cleanup;

        expect(waitedForWrite).toBe(true);
        expect(result.details.truncated).toBe(true);
        expect("fullOutputPath" in result.details).toBe(false);
        expect(removed).toContain("/private/integration-web-output");
    });

    test("keeps search and crawl provider success when temporary storage fails", async () => {
        const fileSystem: WebOutputRetentionFileSystem = {
            async mkdtemp() {
                throw new Error("disk unavailable");
            },
            async chmod() {},
            async writeFile() {},
            async rm() {},
        };
        const registered = host({
            createOutputRetention: () => new WebOutputRetention({ fileSystem }),
            environment: { FIRECRAWL_API_KEY: "fire" },
            fetch: async (url) =>
                String(url).includes("/responses")
                    ? new Response(JSON.stringify({ output_text: "x".repeat(60_000) }))
                    : new Response(JSON.stringify({ data: { markdown: "crawl ".repeat(200) } })),
        });

        const search = await run(registered("web_search"), { query: "storage failure" }, context(openai));
        const crawl = await run(registered("web_crawl"), {
            url: "https://example.test/storage-failure",
            max_bytes: 200,
        });
        for (const result of [search, crawl]) {
            expect(result.details.status).toBe("complete");
            expect(result.details.truncated).toBe(true);
            expect("fullOutputPath" in result.details).toBe(false);
            expect(result.content[0].text).toContain("Complete output was not retained");
        }
        expect(Buffer.byteLength(search.content[0].text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
        expect(Buffer.byteLength(crawl.content[0].text, "utf8")).toBeLessThanOrEqual(200);
    });
});
