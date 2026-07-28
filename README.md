# pui

An OpenCode-inspired, full-screen OpenTUI/Solid client backed by Pi's SDK. It uses Pi's existing auth, models, settings, sessions, tools, skills, prompt templates, context files, and extensions without changing the regular `pi` command.

## Requirements

- The `pi` command installed and configured
- [Bun](https://bun.sh/) 1.3 or newer (build only)
- `fd` (or `fdfind`) and `rg` to use bundled file search; pui still starts without them

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

`bun run check` runs Biome, type-checks, tests, builds, and smoke-tests the final executable. Use `bun run format` to format the project with Biome.

## Clipboard

Highlight text inside pui, then press `Ctrl+Shift+C` to copy it. If a terminal or tmux loses the Shift modifier, pui treats `Ctrl+C` as copy while text is highlighted instead of aborting.

## Included

- Stable streaming Markdown and syntax-colored code blocks
- User, reasoning, tool, shell, queue, custom-message, and compaction views
- Live and resumed subagent cards with lifecycle, child activity, usage, output, and diagnostics
- Responsive OpenCode-style session sidebar with active blocking and background subagents
- Model, session, and `/subagents` background-job pickers plus a command palette
- Inline slash-command completion for built-ins, extensions, prompt templates, and skills
- `@` file picker with fuzzy project search and quoted paths
- Ctrl+G prompt editing in nvim with the last agent response included as read-only reference
- Steering with Enter and follow-ups with Alt+Enter while Pi is working
- Pi session persistence, model/thinking controls, compaction, reload, and abort
- Bundled `fd` file discovery and `rg` content search with safe direct execution and bounded output
- Bundled `web_search` for current web discovery and `web_crawl` for extracting a known URL
- `!command` and `!!command` shell execution

## Subagents

Subagents come from the bundled Pi extension in [`extensions/subagent/`](extensions/subagent/), not Pi core. The extension owns presets, isolated child processes, concurrency, cancellation, timeouts, and output limits. pui consumes its renderer-neutral `pi.subagent` details and restores completed cards from normal Pi sessions.

Omitting the `agent` argument starts a generic write-capable child with no bundled agent prompt, leaving the input task to steer Pi's normal coding context. Select `agent: "worker"` for [Ponytail](https://ponytail.dev/) minimal-coding guidance or `agent: "explore"` for read-only reconnaissance. Write-capable child process isolation is not a filesystem or OS sandbox; use it only in trusted repositories. See the extension guide for model settings and the full security boundary.

Use `Ctrl+O` to expand delegated prompts, child activity, usage, output, and diagnostics. Child tool calls appear in expanded subagent cards but stay out of the session sidebar. Background jobs remain visible there with title, stable model label, elapsed time, and usage; open `/subagents` (also available in the command palette) to inspect recent jobs or explicitly cancel an active one. Persisted background results render as dedicated result messages. Unknown protocol versions and malformed details remain generic tool cards, and legacy session details remain readable.

The regular `pi` command does not auto-load this application-owned extension. Load it explicitly when needed:

```sh
pi -e /absolute/path/to/pui/extensions/subagent/index.ts
```

See the [extension guide](extensions/subagent/README.md) for configuration and troubleshooting.

## Workflows (opt-in)

Programmatic workflows are experimental and remain disabled by default. Start pui with `PUI_WORKFLOWS=1 pui`; this registers the `workflow` tool, `/workflow <name> [JSON args]` for saved definitions, and `/workflows` for run management. Workflows also require an external Node **>=22.19**. Resolution order is `PUI_WORKFLOW_NODE`, a configured workflow Node path, then `node` on `PATH`; an unavailable or old runtime produces an actionable startup/launch error.

An inline workflow is JavaScript using `agent`, `pipeline`, `parallel`, `phase`, `log`, and `args`:

```js
phase("review");
const reports = await parallel([agent("Review API", { role: "explore" }), agent("Review UI", { role: "explore" })]);
return { reports, requestedBy: args.user };
```

Saved definitions add static metadata and can be invoked without regenerating the script:

```js
export const meta = { name: "review-pair", description: "Run two independent reviews" };
return parallel([agent("Review API", { role: "explore" }), agent("Review UI", { role: "explore" })]);
```

Project definitions live at `.pi/workflows/*.js`; personal definitions live at `~/.pi/agent/workflows/*.js`. Lookup walks from the current directory to the repository root: the nearest project definition wins, then more distant project definitions, then personal definitions. Metadata must be one static `export const meta = { name: "lowercase-hyphen-name", description: "..." }` declaration and is parsed without execution.

Every exact script is shown for approval. Choose **Run once** or **Trust unchanged script in this project**; trust is keyed by canonical project, name, and SHA-256 source bytes, so edits require approval again. Project workflows additionally require Pi project trust. Saving supports project or personal scope and refuses symlink traversal.

Use `/workflows` (or the command palette) to inspect runs and pause, resume, stop, retry, restart a completed agent, or save a run; `/workflow` directly launches a saved definition. Pause lets active agents finish but starts no new work. Stop aborts the worker and active agents. Concurrent write-capable agents require `isolation: "worktree"` unless unsafe shared-checkout execution was explicitly allowed. Worktree branches are retained and **never auto-merged**.

Private run artifacts are stored under `~/.pi/agent/workflow-runs/<project-hash>/<run-id>/` (exact source/arguments, snapshots, journal, result, and summary). On startup pui discovers interrupted runs and asks whether to resume, inspect, stop, or defer. Completed structural operations replay from the journal; an operation interrupted before durable completion runs again. Model, tool, and filesystem side effects are therefore **at least once**, not exactly once. Terminal result delivery is durable and idempotent.

Defaults are 4 concurrent agents (configurable ceiling 16), a warning at 25 scheduled agents, 1,000 agents maximum, a 10-minute run/agent timeout, 128 MiB worker old-space, 64 KiB scripts, and 256 KiB worker protocol frames. Direct workflow shell, filesystem, environment, network, imports, child processes, and signals are unavailable. Scripts run in a separate permission-restricted Node process with a stripped VM realm, static preflight, bounded NDJSON, heartbeat supervision, and host-side RPC validation. This is a layered sandbox boundary—not a claim that `node:vm` or agent tool allowlists alone are OS sandboxes. Host agents remain trusted code with capabilities selected by role and policy.

Troubleshooting: set `PUI_WORKFLOW_NODE=/absolute/path/to/node` when Node is missing or the wrong version is found; ensure that path reports >=22.19 with `node --version`. If a run is interrupted, reopen `/workflows` and inspect its recovery artifact before resuming. Permission errors should be fixed by selecting a canonical external Node path, not by weakening Node permission flags.

## File-search tools

pui bundles application-owned `fd` and `rg` tools from [`extensions/file-search/`](extensions/file-search/). They resolve system `fd`/`fdfind` and `rg`, execute without a shell, and retain complete truncated output in a private temporary file. The same `fd` resolver powers `@` completion. See the [file-search extension guide](extensions/file-search/README.md).

The regular `pi` command does not auto-load these tools; load them explicitly with `pi -e /absolute/path/to/pui/extensions/file-search/index.ts`.

## Web tools

pui bundles the application-owned `web_search` and `web_crawl` tools from [`extensions/web/`](extensions/web/). `web_search` uses GPT built-in web search through an authenticated OpenAI Responses or ChatGPT/Codex model. It uses the active model when compatible; otherwise set `WEB_SEARCH_MODEL=provider/model` to a registered, authenticated compatible model. `web_crawl` extracts the main Markdown content of a known HTTP(S) URL through Firecrawl and requires `FIRECRAWL_API_KEY`; `FIRECRAWL_API_URL` optionally selects a hosted or self-hosted endpoint (default: `https://api.firecrawl.dev`).

Both tools cap returned output at 50KB and Pi's default line limit. `web_crawl` accepts a smaller `max_bytes` limit, and `web_search` returns at most 10 source URLs. Complete oversized results may be retained in private temporary files, limited to 10 MiB per result and 50 MiB per web-extension session. A retained path is valid only for the current session and is removed at session shutdown. Retention is best-effort: if storage fails or a quota is reached, the successful tool result still includes a bounded preview, reports that the complete output was not retained, and omits `fullOutputPath`.

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
- `extensions/file-search/` owns bundled `fd`/`rg` schemas, binary resolution, safe process execution, and bounded output.
- `extensions/web/` owns the bundled web-search and Firecrawl tools and their provider-facing tests.
- `src/tool-executions.ts` reduces generic Pi tool lifecycle events, including partial updates.
- `src/subagent.ts` defensively normalizes the versioned extension protocol for presentation.
- `src/app.tsx` is the Solid/OpenTUI view layer.
- `src/format.ts` projects Pi messages and live tool executions into explicit display variants and preserves identity when their presentation is unchanged.
- `src/theme.ts` defines the neutral palette and syntax styles.
- `scripts/build.ts` compiles the Solid application and embeds the bundled extension into `dist/pui`.

The bundled application-owned extensions augment normal Pi discovery: global and trusted project extensions and tools still load from Pi's regular configuration. The subagent emits renderer-neutral details and relies on regular Pi's generic tool fallback outside pui. Other extensions built specifically from `@earendil-works/pi-tui` components cannot render those components inside OpenTUI, but their non-UI hooks, tools, commands, lifecycle events, and renderer-neutral details still work.

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its `CombinedAutocompleteProvider`. This preserves Pi's slash, path, `fd`, quoting, ranking, cancellation, and insertion behavior without maintaining an autocomplete fork; pui's visible renderer remains OpenTUI.
