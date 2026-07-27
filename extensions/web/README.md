# Web tools

This application-owned extension registers `web_search` and `web_crawl`. pui bundles it automatically; regular `pi` does not. For standalone use:

```sh
pi -e /absolute/path/to/pui/extensions/web/index.ts
```

## Configuration

- `web_search` requires a Pi-authenticated OpenAI Responses or ChatGPT/Codex model with built-in web search. It uses the active model by default; set `WEB_SEARCH_MODEL=provider/model` to select another registered model.
- `web_crawl` requires `FIRECRAWL_API_KEY`. Set `FIRECRAWL_API_URL` only to override the default `https://api.firecrawl.dev` endpoint, including for self-hosted Firecrawl.

Returned output is limited to 50KB and Pi's default line limit. `web_crawl` can request a lower `max_bytes`; `web_search` returns at most 10 sources.

When a complete formatted result exceeds its return limit, the extension may retain it in a private temporary `result.md` file and include the path in the tool result. Retention is best-effort: if storage fails or a quota is reached, the tool still returns a bounded preview, reports that the complete output was not retained, and omits `fullOutputPath`. Retention is limited to 10 MiB per result and 50 MiB across one web-extension session.

Retained paths are valid only for the current extension session. Session shutdown waits for pending retention writes and removes every retained web-output file.
