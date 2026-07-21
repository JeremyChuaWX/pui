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
- Responsive OpenCode-style session sidebar
- Model and session pickers plus a command palette
- Inline slash-command completion for built-ins, extensions, prompt templates, and skills
- `@` file picker with fuzzy project search and quoted paths
- Steering with Enter and follow-ups with Alt+Enter while Pi is working
- Pi session persistence, model/thinking controls, compaction, reload, and abort
- `!command` and `!!command` shell execution

## Architecture

- `src/index.tsx` owns OpenTUI renderer startup and shutdown.
- `src/controller.ts` embeds Pi through `AgentSessionRuntime` and rebinds every replaced session.
- `src/app.tsx` is the Solid/OpenTUI view layer.
- `src/format.ts` projects Pi messages into stable display items.
- `src/theme.ts` defines the neutral palette and syntax styles.
- `bin/pi-tui` is the standalone launcher.

Pi extensions and tools are loaded from the normal Pi agent directory. Extensions built specifically from `@earendil-works/pi-tui` components cannot render those visual components inside OpenTUI yet; their non-UI hooks, tools, commands, and lifecycle events still work.
