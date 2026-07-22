# pui

An OpenCode-inspired, full-screen OpenTUI/Solid client backed by Pi's SDK. It uses Pi's existing auth, models, settings, sessions, tools, skills, prompt templates, context files, and extensions without changing the regular `pi` command.

## Requirements

- The `pi` command installed and configured
- [Bun](https://bun.sh/) 1.3 or newer (build only)
- `fd` for fuzzy `@` file completion (optional, but recommended)

## Install

On macOS and Linux:

```sh
cd ~/dev/pui
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run install
```

`bun run build` creates a minified native executable with embedded source maps for the current platform. The output is `dist/pui` on macOS and Linux or `dist/pui.exe` on Windows. Running it does not require Bun or this project's `node_modules`.

On macOS and Linux, `install` links the executable into `~/.local/bin`; make sure that directory is on `PATH`. On Windows, add `dist/pui.exe` to `PATH` manually.

## Run

```sh
pui
pui -c
pui "review this repository"
```

Run `pui --help` for startup flags. Inside the app, use `Ctrl+K` or `/help`.

For development, run the source directly from the project:

```sh
bun run start -- --no-session
bun run check
```

`bun run check` type-checks, tests, builds, and smoke-tests the final executable.

## Clipboard

Highlight text inside pui, then press `Ctrl+Shift+C` to copy it. If a terminal or tmux loses the Shift modifier, pui treats `Ctrl+C` as copy while text is highlighted instead of aborting.

## Included

- Stable streaming Markdown and syntax-colored code blocks
- User, reasoning, tool, shell, queue, custom-message, and compaction views
- Live and resumed subagent cards with lifecycle, child activity, usage, output, and diagnostics
- Responsive OpenCode-style session sidebar with active subagent instances
- Model and session pickers plus a command palette
- Inline slash-command completion for built-ins, extensions, prompt templates, and skills
- `@` file picker with fuzzy project search and quoted paths
- Ctrl+G prompt editing in nvim with the last agent response included as read-only reference
- Steering with Enter and follow-ups with Alt+Enter while Pi is working
- Pi session persistence, model/thinking controls, compaction, reload, and abort
- Bundled `web_search` for current web discovery and `web_crawl` for extracting a known URL
- `!command` and `!!command` shell execution

## Subagents

Subagents come from the bundled Pi extension in [`extensions/subagent/`](extensions/subagent/), not Pi core. The extension owns presets, isolated child processes, concurrency, cancellation, timeouts, and output limits. pui consumes its renderer-neutral `pi.subagent` details and restores completed cards from normal Pi sessions.

Omitting the `agent` argument starts a generic write-capable child with no bundled agent prompt, leaving the input task to steer Pi's normal coding context. Select `agent: "worker"` for [Ponytail](https://ponytail.dev/) minimal-coding guidance or `agent: "explore"` for read-only reconnaissance. Write-capable child process isolation is not a filesystem or OS sandbox; use it only in trusted repositories. See the extension guide for model settings and the full security boundary.

Use `Ctrl+O` to expand delegated prompts, child activity, usage, output, and diagnostics. Unknown protocol versions and malformed details remain generic tool cards, and legacy session details remain readable.

The regular `pi` command does not auto-load this application-owned extension. Load it explicitly when needed:

```sh
pi -e /absolute/path/to/pui/extensions/subagent/index.ts
```

See the [extension guide](extensions/subagent/README.md) for configuration and troubleshooting.

## Web tools

pui bundles the application-owned `web_search` and `web_crawl` tools from [`extensions/web/`](extensions/web/). `web_search` uses GPT built-in web search through an authenticated OpenAI Responses or ChatGPT/Codex model. It uses the active model when compatible; otherwise set `WEB_SEARCH_MODEL=provider/model` to a registered, authenticated compatible model. `web_crawl` extracts the main Markdown content of a known HTTP(S) URL through Firecrawl and requires `FIRECRAWL_API_KEY`; `FIRECRAWL_API_URL` optionally selects a hosted or self-hosted endpoint (default: `https://api.firecrawl.dev`).

Both tools cap returned output at 50KB and Pi's default line limit. `web_crawl` accepts a smaller `max_bytes` limit. When output is truncated, the complete result is saved to a temporary file and its path is returned; `web_search` returns at most 10 source URLs.

Like the bundled subagent, these tools are loaded by pui independently of normal extension discovery. The regular `pi` command does not auto-load them. To use them there, load the extension explicitly:

```sh
pi -e /absolute/path/to/pui/extensions/web/index.ts
```

See the [web extension guide](extensions/web/README.md) for the compact configuration reference.

## Architecture

- `src/index.tsx` owns OpenTUI renderer startup and shutdown.
- `src/controller.ts` embeds Pi through `AgentSessionRuntime`, rebinds every replaced session, and adapts Pi's `CombinedAutocompleteProvider` to OpenTUI prompt completions.
- `src/bundled-extensions.ts` registers application-owned extension factories independently of session cwd.
- `extensions/subagent/` owns the standalone subagent extension, protocol producer, preset, fixtures, and tests.
- `extensions/web/` owns the bundled web-search and Firecrawl tools and their provider-facing tests.
- `src/tool-executions.ts` reduces generic Pi tool lifecycle events, including partial updates.
- `src/subagent.ts` defensively normalizes the versioned extension protocol for presentation.
- `src/app.tsx` is the Solid/OpenTUI view layer.
- `src/format.ts` projects Pi messages and live tool executions into explicit display variants and preserves identity when their presentation is unchanged.
- `src/theme.ts` defines the neutral palette and syntax styles.
- `scripts/build.ts` compiles the Solid application and embeds the bundled extension into `dist/pui`.

The bundled application-owned extensions augment normal Pi discovery: global and trusted project extensions and tools still load from Pi's regular configuration. The subagent emits renderer-neutral details and relies on regular Pi's generic tool fallback outside pui. Other extensions built specifically from `@earendil-works/pi-tui` components cannot render those components inside OpenTUI, but their non-UI hooks, tools, commands, lifecycle events, and renderer-neutral details still work.

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its `CombinedAutocompleteProvider`. This preserves Pi's slash, path, `fd`, quoting, ranking, cancellation, and insertion behavior without maintaining an autocomplete fork; pui's visible renderer remains OpenTUI.
