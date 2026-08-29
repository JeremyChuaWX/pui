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

`bun run check` runs Biome, type-checks, checks the layer boundaries, tests, builds, and smoke-tests the final executable. Use `bun run format` to format the project with Biome.

## Clipboard

Highlight text inside pui, then press `Ctrl+Shift+C` to copy it. If a terminal or tmux loses the Shift modifier, pui treats `Ctrl+C` as copy while text is highlighted instead of aborting.

## Included

- Stable streaming Markdown and syntax-colored code blocks
- User, reasoning, tool, shell, queue, custom-message, and compaction views
- Responsive OpenCode-style session sidebar with active background Jobs
- Model, session, and `/subagents` background-job pickers plus a command palette
- Inline slash-command completion for built-ins, extensions, prompt templates, and skills
- `@` file picker with fuzzy project search and quoted paths
- Ctrl+G prompt editing in nvim with the last agent response included as read-only reference
- Steering with Enter and follow-ups with Alt+Enter while Pi is working
- Pi session persistence, model/thinking controls, compaction, reload, and abort
- Bundled `fd` file discovery and `rg` content search with safe direct execution and bounded output
- Bundled `web_search` for current web discovery and `web_crawl` for extracting a known URL
- Bundled `unslop` skill for removing AI writing patterns
- `!command` and `!!command` shell execution

## Skills

pui bundles the [`unslop`](src/pi-core/skills/unslop/SKILL.md) writing skill from
[`backnotprop/pstack`](https://github.com/backnotprop/pstack/blob/main/skills/unslop/SKILL.md). The skill and its
[MIT license](src/pi-core/skills/unslop/LICENSE.txt) are embedded in the standalone executable. At startup, pui copies them to a
private temporary directory and passes its `SKILL.md` to Pi as an additional skill. This keeps the skill readable by
Pi's tools while normal global and trusted project skill discovery still works.

## Subagents

Subagents come from the subagents Module in [`src/modules/subagents/`](src/modules/subagents/), not Pi core. The Module owns isolated child processes, concurrency, cancellation, timeouts, and output limits, and draws its Agent Roles from the Child-Agent Runtime. pui consumes its Background Protocol to list and cancel Jobs.

The `worker` tool spawns a write-capable child with [Ponytail](https://ponytail.dev/) minimal-coding guidance; the `explorer` tool spawns a read-only child for reconnaissance. Each returns a Job id at once. Write-capable child process isolation is not a filesystem or OS sandbox; use it only in trusted repositories. See the extension guide for model settings and the full security boundary.

Background jobs stay visible in the sidebar with title, stable model label, elapsed time, and usage; open `/subagents` (also available in the command palette) to inspect recent jobs or explicitly cancel an active one. Persisted background results render as dedicated result messages.

This Extension is built into pui. It is not a standalone `pi` extension, and the regular `pi` command does not load it.

See the [extension guide](src/modules/subagents/README.md) for configuration and troubleshooting.

## File-search tools

pui bundles application-owned `fd` and `rg` tools from [`src/modules/file-search/`](src/modules/file-search/). They resolve system `fd`/`fdfind` and `rg`, execute without a shell, and retain complete truncated output in a private temporary file. The same `fd` resolver powers `@` completion. See the [file-search extension guide](src/modules/file-search/README.md).

These tools are built into pui; the regular `pi` command does not load them.

## Web tools

pui bundles the application-owned `web_search` and `web_crawl` tools from [`src/modules/web/`](src/modules/web/). `web_search` uses GPT built-in web search through an authenticated OpenAI Responses or ChatGPT/Codex model. It uses the active model when compatible; otherwise set `WEB_SEARCH_MODEL=provider/model` to a registered, authenticated compatible model. `web_crawl` extracts the main Markdown content of a known HTTP(S) URL through Firecrawl and requires `FIRECRAWL_API_KEY`; `FIRECRAWL_API_URL` optionally selects a hosted or self-hosted endpoint (default: `https://api.firecrawl.dev`).

Both tools cap returned output at 50KB and Pi's default line limit. `web_crawl` accepts a smaller `max_bytes` limit, and `web_search` returns at most 10 source URLs. Complete oversized results may be retained in private temporary files, limited to 10 MiB per result and 50 MiB per web-extension session. A retained path is valid only for the current session and is removed at session shutdown. Retention is best-effort: if storage fails or a quota is reached, the successful tool result still includes a bounded preview, reports that the complete output was not retained, and omits `fullOutputPath`.

Like the other Modules, these tools are built into pui and loaded independently of normal extension discovery; the regular `pi` command does not load them.

See the [web extension guide](src/modules/web/README.md) for the compact configuration reference.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design: layers, module map, protocol
ownership, dependency-injection conventions, and the testing strategy. The source under `src/` is
five top-level layers (`app/`, `ui/`, `pi-core/`, `modules/`, `shared/`) with one-way dependency
edges enforced by a boundary check in `bun run check`. The short version:

- `src/app/index.tsx` owns CLI dispatch and invokes the UI's single start function, `src/ui/start.tsx`,
  which owns OpenTUI renderer startup and shutdown.
- `src/ui/state/controller.ts` (`PuiController`) is the stateful hub: it embeds Pi through
  `AgentSessionRuntime`, rebinds every replaced session, reduces events into immutable
  `PuiSnapshot`s, and exposes every user action as a method. Its collaborators are injectable with
  production defaults: the subagents Module's UI Entry (`BackgroundSubagentBridge`) and
  `src/ui/state/controller-queues.ts` (bounded dialogs and notifications). The controller's command table
  drives slash-command autocomplete and dispatch.
- `src/ui/components/app.tsx` is the Solid/OpenTUI shell; rendering and menu construction live in
  `src/ui/components/` (`menus.ts` builds every picker behind a testable `MenuHost` seam, `keys.ts` owns
  all keyboard predicates, plus dialog/transcript/prompt/sidebar components).
- `src/ui/state/format.ts` projects Pi messages and live tool executions into display variants and
  preserves item identity when presentation is unchanged; `src/ui/state/tool-executions.ts` reduces tool
  lifecycle events; the subagents Module's UI Entry validates and bounds the subagent protocol for
  display.
- `src/modules/file-search/`, `src/modules/web/`, and `src/modules/subagents/` are the three Modules
  behind their Interfaces Directories, registered via Pi Core's Register File
  `src/pi-core/register.ts`. Each Module owns its wire protocol; consumers reach parsed state
  through the Module's UI Entry instead of maintaining mirrors.
- `src/shared/` holds the Shared Primitives importable from every layer: `src/shared/lib/` (the
  generic library: validation, bounded processes, and retained output). The child-agent runner
  and its Profiles live in `src/modules/subagents/`.
- `src/pi-core/skills/` holds application-owned skills, registered via `src/pi-core/bundled-skills.ts`.
- `scripts/build.ts` compiles the Solid application and embeds the bundled extensions, skills, and
  skill licenses into `dist/pui`.

The bundled application-owned resources augment normal Pi discovery: global and trusted project extensions, tools, and skills still load from Pi's regular configuration. The subagent emits renderer-neutral details and relies on regular Pi's generic tool fallback outside pui. Other extensions built specifically from `@earendil-works/pi-tui` components cannot render those components inside OpenTUI, but their non-UI hooks, tools, commands, lifecycle events, and renderer-neutral details still work.

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its `CombinedAutocompleteProvider`. This preserves Pi's slash, path, `fd`, quoting, ranking, cancellation, and insertion behavior without maintaining an autocomplete fork; pui's visible renderer remains OpenTUI.
