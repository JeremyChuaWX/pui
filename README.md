# Pi OpenTUI

An OpenCode-inspired, full-screen OpenTUI/Solid client backed by Pi's SDK. It uses Pi's existing auth, models, settings, sessions, tools, skills, prompt templates, context files, and extensions without changing the regular `pi` command.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- The `pi` command installed and configured
- `fd` for fuzzy `@` file completion (optional, but recommended)

## Install

```sh
cd ~/dev/pi-tui
npm ci --ignore-scripts
npm run install:local
```

This links `pi-tui` into `~/.local/bin`. Make sure that directory is on `PATH`.

## Run

```sh
pi-tui
pi-tui -c
pi-tui "review this repository"
```

Run `pi-tui --help` for startup flags. Inside the app, use `Ctrl+K` or `/help`.

For development, run directly from the project:

```sh
npm start -- --no-session
npm run check
```

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

Subagents are supplied by the Pi extension in [`extensions/subagent/`](extensions/subagent/); they are not built into Pi core. pi-tui bundles that extension and loads it directly into every embedded Pi runtime, independent of the launch or session working directory. The extension remains responsible for presets, process isolation, concurrency, timeout, cancellation, and output limits.

pi-tui recognizes the renderer-neutral `pi.subagent` protocol in ordinary tool-result `details` and shows queued, starting, running, succeeded, failed, cancelled, and timed-out calls independently. `Ctrl+O` expands delegated prompts, working directories, child activity, usage, live previews, final Markdown, diagnostics, and any full-output path. Terminal protocol details are stored in the normal Pi session, so completed cards are restored on resume. Legacy `{ agent, model, toolCalls, usage }` details remain readable; malformed and unknown protocol versions stay generic.

The regular `pi` command does not auto-load this application-bundled extension. To use the standalone source explicitly, run:

```sh
pi -e /absolute/path/to/pi-tui/extensions/subagent/index.ts
```

See the [extension README](extensions/subagent/README.md) for configuration and troubleshooting.

## Architecture

- `src/index.tsx` owns OpenTUI renderer startup and shutdown.
- `src/controller.ts` embeds Pi through `AgentSessionRuntime` and rebinds every replaced session.
- `src/bundled-extensions.ts` resolves application-owned extension entry points independently of session cwd.
- `extensions/subagent/` owns the standalone extension, protocol producer, preset, fixtures, and tests.
- `src/tool-executions.ts` reduces generic Pi tool lifecycle events, including partial updates.
- `src/subagent.ts` defensively normalizes the versioned extension protocol for presentation.
- `src/app.tsx` is the Solid/OpenTUI view layer.
- `src/format.ts` projects Pi messages and live tool executions into stable display items.
- `src/theme.ts` defines the neutral palette and syntax styles.
- `bin/pi-tui` is the standalone launcher.

The bundled subagent extension augments normal Pi discovery: global and trusted project extensions and tools still load from Pi's regular configuration. Extensions built specifically from `@earendil-works/pi-tui` components cannot render those visual components inside OpenTUI; their non-UI hooks, tools, commands, lifecycle events, and renderer-neutral structured details still work.
