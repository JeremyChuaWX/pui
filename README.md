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
bun install --frozen-lockfile
bun run build
bun run link
```

`bun run build` creates a minified native executable with embedded source maps for the current platform. The output is `dist/pui` on macOS and Linux or `dist/pui.exe` on Windows. Running it does not require Bun or this project's `node_modules`.

On macOS and Linux, `bun run link` links the executable into `~/.local/bin`; make sure that directory is on `PATH`. On Windows, add `dist/pui.exe` to `PATH` manually.

## Run

```sh
pui
pui -c
pui "review this repository"
```

Run `pui --help` for startup flags. Inside the app, use `Ctrl+K` or `/help`.

`pui --smoke` boots Pi headlessly against a throwaway agent directory with only the bundled Extensions and skills, prints the registered tool and skill names as one JSON line, and exits. It never reads your Pi configuration. The exit code is non-zero if any bundled Extension failed to load or a bundled skill produced a diagnostic. The build gate runs it against the compiled binary.

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
- Responsive OpenCode-style session sidebar listing active background Jobs
- Model and session pickers plus a command palette
- Inline slash-command completion for built-ins, extensions, prompt templates, and skills
- `@` file picker with fuzzy project search and quoted paths
- Ctrl+G prompt editing in `$VISUAL` or `$EDITOR` (nvim by default) with the last agent response included as read-only reference
- Steering with Enter and follow-ups with Alt+Enter while Pi is working
- Pi session persistence, model/thinking controls, compaction, reload, and abort
- Bundled `fd` file discovery and `rg` content search with safe direct execution and bounded output
- Bundled `explorer` and `worker` subagents with `subagent_cancel` and non-blocking `subagent_list`
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

The subagents Module in [`src/modules/subagents/`](src/modules/subagents/) follows the subagent Extension in the user's local Pi setup. It owns the two Profiles, isolated child `AgentSession`s, the Job Manager, two Limits, retained results, and the Background Protocol read by the sidebar. Nothing here loads into the regular `pi` command.

### Tools

The Extension registers four tools.

| Tool | What it does |
| --- | --- |
| `explorer` | Starts a read-only child under the `explorer` Profile and returns its Job id at once |
| `worker` | Starts a write-capable child under the `worker` Profile and returns its Job id at once |
| `subagent_cancel` | Cancels queued or running Jobs and returns once each reaches a terminal state |
| `subagent_list` | Returns an immediate queued/running snapshot; it never waits or polls |

`explorer` and `worker` take `{ task, cwd? }`; `cwd` defaults to the parent session's working directory and relative values resolve from it.

### Profiles

| Profile | Child tools | Prompt | Model | Thinking |
| --- | --- | --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls` | Replaces Pi's coding prompt with read-only exploration guidance | `openrouter/z-ai/glm-5.3-flash` | low |
| `worker` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | Appends minimal coding guidance to Pi's coding prompt | `openrouter/z-ai/glm-5.3-flash` | high |

Each child is an in-process `AgentSession` with session persistence, extensions, skills, prompt templates, themes, and context files disabled, so it cannot load this Extension recursively.

`PI_SUBAGENT_MAX_ACTIVE` sets per-session concurrency. The default is 4 and the valid range is 1 to 64; up to 16 additional Jobs queue in FIFO order and can be cancelled before they start.

### Limits

Every Job has a 10-minute inactivity Limit, reset by child activity, and a 60-minute hard Limit. Either aborts the child `AgentSession` and produces a `timed_out` result. Reload, session switch, fork, and quit cancel every remaining Job. Jobs are not restored across sessions.

### Results

A finished Job is written to `<temp>/pi-subagents/<session-id>/<job-id>.md`; a numeric suffix preserves an existing result with the same Job id after reload. The result is injected once as a `subagent-result` steer message with `triggerTurn` set. A steer arrives after the current assistant response's tools and before its next model call, avoiding the old blocking-wait and delayed-follow-up race. The inline preview is capped at 16 KiB.

The transcript renders a "Background subagent result" card. The sidebar lists active Jobs with Profile, status, and elapsed time. Cancellation remains available to the model through `subagent_cancel`.

Worker Jobs are write-capable and not sandboxed. They can edit files and run arbitrary shell commands, inherit the parent environment, and are not confined to `cwd`. Use `worker` only in trusted repositories. The explorer's read-only allowlist is a Pi tool restriction, not an operating-system sandbox.

See the [subagents Module guide](src/modules/subagents/README.md) for the runtime, result delivery, and pui UI adapter.

## File-search tools

pui bundles application-owned `fd` and `rg` tools from [`src/modules/file-search/`](src/modules/file-search/). They resolve system `fd`/`fdfind` and `rg`, execute without a shell, and retain complete truncated output in a private temporary file. The same `fd` resolver powers `@` completion. See the [file-search extension guide](src/modules/file-search/README.md).

These tools are built into pui; the regular `pi` command does not load them.

## Web tools

pui bundles the application-owned `web_search` and `web_crawl` tools from [`src/modules/web/`](src/modules/web/). `web_search` calls the ChatGPT Codex standalone search endpoint, which runs searches server-side without model inference, so searches consume no model tokens. It needs ChatGPT/Codex credentials, resolved in order: `CODEX_ACCESS_TOKEN` (with optional `CODEX_ACCOUNT_ID`), a Pi-authenticated ChatGPT/Codex model (the active model, or `WEB_SEARCH_MODEL=provider/model` to select another registered one), then the Codex CLI login at `~/.codex/auth.json`. `web_crawl` extracts the main Markdown content of a known HTTP(S) URL through Firecrawl and requires `FIRECRAWL_API_KEY`; `FIRECRAWL_API_URL` optionally selects a hosted or self-hosted endpoint (default: `https://api.firecrawl.dev`).

Both tools cap returned output at 50KB and Pi's default line limit. `web_crawl` accepts a smaller `max_bytes` limit, and `web_search` returns at most 10 source URLs. Complete oversized results may be retained in private temporary files, limited to 10 MiB per result and 50 MiB per web-extension session. A retained path is valid only for the current session and is removed at session shutdown. Retention is best-effort: if storage fails or a quota is reached, the successful tool result still includes a bounded preview, reports that the complete output was not retained, and omits `fullOutputPath`.

Like the other Modules, these tools are built into pui and loaded independently of normal extension discovery; the regular `pi` command does not load them.

See the [web extension guide](src/modules/web/README.md) for the compact configuration reference.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design: layers, module map, protocol
ownership, dependency-injection conventions, and the testing strategy. The source under `src/` is
five top-level layers (`app/`, `ui/`, `pi-core/`, `modules/`, `shared/`) with one-way dependency
edges enforced by a boundary check in `bun run check`. The short version:

- `src/app/index.tsx` owns CLI dispatch. It starts the TUI through the UI's single start function,
  `src/ui/start.tsx`, or runs the headless `--smoke` entry in `src/app/smoke.ts`. The App never
  imports a Module.
- `src/ui/state/controller.ts` (`PuiController`) is the stateful hub: it embeds Pi through
  `AgentSessionRuntime`, rebinds every replaced session, reduces events into immutable
  `PuiSnapshot`s, and exposes every user action as a method. Its collaborators are injectable with
  production defaults: the subagents Module's UI Entry (`BackgroundSubagentBridge`) and
  `src/ui/state/controller-queues.ts` (bounded dialogs and notifications). The controller's command
  table drives slash-command autocomplete, dispatch, and the palette.
- `src/ui/components/app.tsx` is the Solid/OpenTUI shell; rendering and menu construction live in
  `src/ui/components/` (`menus.ts` builds every picker behind a testable `MenuHost` seam, `keys.ts`
  owns all keyboard predicates, plus dialog, transcript, prompt, and sidebar components).
- `src/ui/state/format.ts` projects Pi messages and live tool executions into display variants and
  preserves item identity when presentation is unchanged; `src/ui/state/tool-executions.ts` reduces
  tool lifecycle events; the subagents Module's UI Entry validates and bounds the Background
  Protocol for display.
- `src/modules/file-search/`, `src/modules/web/`, and `src/modules/subagents/` are the three
  Modules behind their Interfaces Directories (`interfaces/pi.ts`, plus `interfaces/ui.ts` where
  the UI needs it), registered by Pi Core's Register File `src/pi-core/register.ts`. Each Module
  owns its wire protocol; consumers reach parsed state through the Module's UI Entry instead of
  maintaining mirrors. The subagents Module owns its Profiles and the child runner outright (ADR
  0002).
- `src/shared/lib/` holds the Shared Primitives importable from every layer: validation, bounded
  processes, retained output, and the injectable clock. Only code with two or more consumers lives
  there.
- `src/pi-core/skills/` holds application-owned skills, registered via
  `src/pi-core/bundled-skills.ts`.
- `scripts/build.ts` compiles the Solid application and embeds the bundled extensions, skills, and
  skill licenses into `dist/pui`.

The bundled application-owned resources augment normal Pi discovery: global and trusted project extensions, tools, and skills still load from Pi's regular configuration. Other extensions built specifically from `@earendil-works/pi-tui` components cannot render those components inside OpenTUI, but their non-UI hooks, tools, commands, lifecycle events, and renderer-neutral details still work.

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its `CombinedAutocompleteProvider`. This preserves Pi's slash, path, `fd`, quoting, ranking, cancellation, and insertion behavior without maintaining an autocomplete fork; pui's visible renderer remains OpenTUI.
