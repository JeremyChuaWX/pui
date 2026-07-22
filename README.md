# pui

An OpenCode-inspired, full-screen OpenTUI/Solid client backed by Pi's SDK. It uses Pi's existing auth, models, settings, sessions, tools, skills, prompt templates, context files, and extensions without changing the regular `pi` command.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- The `pi` command installed and configured
- `fd` for fuzzy `@` file completion (optional, but recommended)

## Install

```sh
cd ~/dev/pui
bun install --frozen-lockfile --ignore-scripts
bun run install:local
```

This links `pui` into `~/.local/bin`. Make sure that directory is on `PATH`.

## Run

```sh
pui
pui -c
pui "review this repository"
```

Run `pui --help` for startup flags. Inside the app, use `Ctrl+K` or `/help`.

For development, run directly from the project:

```sh
bun run start -- --no-session
bun run check
```

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

## Architecture

- `src/index.tsx` owns OpenTUI renderer startup and shutdown.
- `src/controller.ts` embeds Pi through `AgentSessionRuntime`, rebinds every replaced session, and adapts Pi's `CombinedAutocompleteProvider` to OpenTUI prompt completions.
- `src/bundled-extensions.ts` resolves application-owned extension entry points independently of session cwd.
- `extensions/subagent/` owns the standalone extension, protocol producer, preset, fixtures, and tests.
- `src/tool-executions.ts` reduces generic Pi tool lifecycle events, including partial updates.
- `src/subagent.ts` defensively normalizes the versioned extension protocol for presentation.
- `src/app.tsx` is the Solid/OpenTUI view layer.
- `src/format.ts` projects Pi messages and live tool executions into explicit display variants and preserves identity when their presentation is unchanged.
- `src/theme.ts` defines the neutral palette and syntax styles.
- `bin/pui` is the standalone launcher.

The bundled subagent extension augments normal Pi discovery: global and trusted project extensions and tools still load from Pi's regular configuration. It emits renderer-neutral details and relies on regular Pi's generic tool fallback outside pui. Other extensions built specifically from `@earendil-works/pi-tui` components cannot render those components inside OpenTUI, but their non-UI hooks, tools, commands, lifecycle events, and renderer-neutral details still work.

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its `CombinedAutocompleteProvider`. This preserves Pi's slash, path, `fd`, quoting, ranking, cancellation, and insertion behavior without maintaining an autocomplete fork; pui's visible renderer remains OpenTUI.

## Development documentation

- [Codebase simplification plan](docs/codebase-simplification-plan.md)
