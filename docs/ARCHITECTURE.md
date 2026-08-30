# pui architecture

pui is a full-screen OpenTUI/Solid client for Pi. The source under `src/` is organized into five
top-level layers. Each feature is a self-contained Module whose only importable part is its
Interfaces Directory, every dependency edge points one way, and a boundary check in `bun run check`
enforces the edges. Within each layer the design favors deep modules: significant machinery hidden
behind a narrow interface, collaborators injected through an options bag with production defaults,
tests written at that interface.

The vocabulary used here (Module, Extension, Pi Core, App, Controller, Register File, Shared
Primitive, Interfaces Directory, UI Entry, Profile, Job, Limits, Background Protocol) is defined in
the glossary in `CONTEXT.md`. Docs and code comments keep to it.

## The five layers

```
src/app/       entry points + pui process management
  ├──▶ src/ui/start.tsx                    the UI's single start function
  └──▶ src/pi-core/                        the --smoke entry boots bundled Extensions and skills
       (the App never imports a Module)

src/ui/        ui/state (the Controller) + ui/components (OpenTUI/Solid views)
  ├──▶ src/pi-core/                        extension factories + bundled skills
  └──▶ src/modules/*/interfaces/ui.ts      UI Entries (parsed view state)

src/pi-core/   the Register File + bundled skills
  └──▶ src/modules/*/interfaces/pi.ts      Extensions

src/modules/   file-search   web   subagents
  └──▶ src/shared/ only, never another Module

src/shared/    Shared Primitives: lib
  └──▶ src/shared/ only
```

`src/shared/` is importable from every layer; nothing imports `src/app/`. The other entry in `src/`
is `src/assets.d.ts`, which contains ambient declarations for bundled text and Markdown assets.
Tests live in the sibling `test/` tree, mirroring production paths where useful. Shared test helpers
live in `test/support/`, and process fixtures live with their tests under `test/modules/`. Everything
else at the repo root is not source: `scripts/` holds the build, smoke-test, and boundary-check
scripts, and `docs/` and `issues/` hold documentation.

### App, `src/app/`

`src/app/index.tsx` parses CLI flags and starts the interactive TUI via `startUi` in
`src/ui/start.tsx`, the UI's single start function, which creates the controller and renderer and
mounts the Solid shell. The UI is imported lazily so `--help` never evaluates OpenTUI.

`pui --smoke` dispatches to `src/app/smoke.ts` instead. It boots Pi headlessly against an isolated
temporary agent directory with only the bundled Extensions and skills, prints the registered tool
and skill names plus any extension errors and skill diagnostics as one JSON line, and exits
non-zero if either error list is non-empty. It never reads the user's Pi configuration. The smoke
entry is also imported lazily, so the TUI path pays nothing for it.

A prompt argument is handed to the App as `initialPrompt` and dispatched through the same
prompt-action record as interactive input, so command-line slash invocations (`pui "/models"`)
perform their action.

### UI, `src/ui/`

The UI is two directories plus the start function: `src/ui/state/` (the Controller and its state
collaborators), `src/ui/components/` (the OpenTUI/Solid views), and `src/ui/start.tsx` (renderer
creation and mounting). The UI reaches features only through Module UI Entries
(`src/modules/*/interfaces/ui.ts`), never feature protocol files.

#### Controller, `src/ui/state/controller.ts`

`PuiController` is the single stateful hub. It embeds Pi through `AgentSessionRuntime`, rebinds on
every session replacement, reduces session and tool events into an immutable `PuiSnapshot`, and
publishes snapshots to subscribers with 16 ms coalescing. Everything the UI can do is a public
method on the controller.

Its constructor is public and takes `ControllerDependencies`. `eventBus`, `extensionFactories`,
and `readGitBranch` all have production defaults, so tests construct a controller against fake
runtimes and a private event bus without casts. `PuiController.create(options, dependencies?)` is
the production factory (session manager selection plus runtime construction).

The controller delegates to focused collaborators rather than owning every concern:

| Collaborator | Interface | Hides |
|---|---|---|
| `src/modules/subagents/interfaces/ui.ts` | `BackgroundSubagentBridge` | active-Job snapshot parsing and bounded view models |
| `src/modules/file-search/interfaces/ui.ts` | `fdCompletionCommand` | system `fd`/`fdfind` resolution for `@` file completion |
| `src/ui/state/controller-queues.ts` | `ExtensionDialogQueue`, `ToastQueue` | bounded extension dialogs, aborts, timeouts, FIFO resolution, and self-expiring notifications |

The controller's command descriptor list is the single source for slash-command autocomplete,
aliases, dispatch, and the command palette. Palette rows (including palette-only entries) live on
the same descriptors, and `src/ui/components/menus.ts` renders them rank-sorted and binds each
row's action through an exhaustive record, so the two lists cannot drift.

The controller's remaining state collaborators live beside it in `src/ui/state/`: `format.ts`
(message to `DisplayItem` projection with identity-preserving reconciliation),
`tool-executions.ts` (tool lifecycle reducer), `types.ts` (shared view types), and
`prompt-autocomplete.ts` (text-position math).

#### Components, `src/ui/components/`

`App` (`src/ui/components/app.tsx`) owns only UI state (prompt text, dialogs, completions, keyboard
handling) and renders snapshots:

| File | Contents |
|---|---|
| `src/ui/components/menus.ts` | every picker and the palette, built behind the `MenuHost` seam (`openDialog`, `openAsyncPicker`, a narrow `MenuController` slice of the controller); pure data, unit-tested with fakes |
| `src/ui/components/dialogs.tsx` | `DialogState`, the modal `Dialog` (picker, confirm, input, help), and the pure `extensionDialogState` derivation from extension dialog requests |
| `src/ui/components/transcript.tsx` | message, tool, bash, summary, and subagent-result cards |
| `src/ui/components/prompt.tsx` | prompt textarea plus autocomplete popover |
| `src/ui/components/sidebar.tsx` | session sidebar with the active Jobs list, and the toast stack |
| `src/ui/components/keys.ts` | all keyboard knowledge: the global shortcut table (one entry per binding drives `globalKeyIntent` dispatch in the app and the Help dialog's `globalKeyHelp` lines), `listNavigationDirection` list cycling, dismissal, enter detection, prompt-history keys, and extension-confirm intents with their hint strings |
| `src/ui/components/subagent-view.ts` | Job presentation: status icons, labels, colors, elapsed time, usage summaries |

View-side helpers `app-support.ts` (prompt history, selection copy, focus trapping, external
editor) and `theme.ts` also live in `src/ui/components/`.

### Pi Core, `src/pi-core/`

Pi Core owns registration. The Register File, `src/pi-core/register.ts`, is the single composition
root that wires the bundled Extensions. Pi Core imports nothing from a Module except its Extension
(`interfaces/pi.ts`), plus shared. `createBundledExtensionFactories(options?)` supplies every
production collaborator explicitly, while accepting per-extension fake bags for boundary tests;
`BUNDLED_EXTENSION_FACTORIES` is its production result. Each `register*Extension(pi, dependencies =
{})` takes an options bag, and each Extension's default export, the module shape Pi's extension
loader expects, calls a small `createDefault*Dependencies` helper with the same production wiring.
The registration tests load the Extensions through Pi's own resource loader to prove it. The
Extensions are built into pui and are not offered for standalone `pi -e` use.

`src/pi-core/skills/unslop/` contains the bundled writing skill and its upstream MIT license.
`src/pi-core/bundled-skills.ts` imports both with Bun's file loader, then copies them to a private
temporary directory. This gives Pi and its tools ordinary filesystem paths instead of Bun's
`$bunfs` paths, which `fs.readFile` can read but `fs.access` cannot. The controller (and the smoke
entry) supplies the copied `SKILL.md` through `additionalSkillPaths`, alongside Pi's normal global
and trusted project discovery, and removes the temporary directory on disposal.

### Modules, `src/modules/`

Each feature lives in one directory under `src/modules/`. A Module owns its logic, state, and wire
protocols; Modules never import each other and may import only `src/shared/` (plus npm and the Pi
SDK). From outside a Module, only its Interfaces Directory (`src/modules/<name>/interfaces/`) is
importable; everything else is private. The entry names are fixed, and each entry is consumed by
exactly one layer:

| Entry | Consumer | Role |
|---|---|---|
| `interfaces/pi.ts` | Pi Core's Register File | the Extension. Required; its default export is Pi's extension-module shape. Built into pui, not a standalone `pi` extension |
| `interfaces/ui.ts` | the UI | the UI Entry: view models, protocol parsers, and bridges. The only way UI code reaches the Module |

What each Module publishes:

| Module | `pi` | `ui` |
|---|---|---|
| `file-search` | `fd` and `rg` tools | the `@`-completion command |
| `web` | `web_search` and `web_crawl` | none |
| `subagents` | `explorer`, `worker`, `subagent_cancel`, `subagent_list` | Background Protocol parser, `BackgroundSubagentBridge`, and status helpers |

Inside their private files, the Modules are deep:

- `src/modules/file-search/`: `process.ts` is the deep module. `runFileSearch` hides shell-free
  spawning, process-group kill, timeouts, and bounded output capture with temp-file spill (capture
  creation is an injectable seam). `bounded-process.ts` owns that Module's process-tree termination
  and bounded capture; `args.ts` builds argv and `binaries.ts` resolves system binaries.
- `src/modules/subagents/`: the Module follows the local Pi subagent Extension. `profiles/` holds
  the two Profiles, one directory each with a declaration and prompt, plus `profile.ts` with the
  default inactivity and hard Limits. `subagent.ts` creates one isolated, in-process child
  `AgentSession` per Job with extensions, skills, templates, context files, themes, and session
  persistence disabled. `manager.ts` owns Profile-scoped ids, the FIFO queue, per-session
  concurrency, cancellation, Limits, and the single delivery path. `result-message.ts` retains full
  output and builds the collapsible `subagent-result` message, which the Extension sends as a Pi
  `steer`. `protocol.ts` owns the Job types and complete active-Job snapshot event;
  `background-bridge.ts` validates and bounds those snapshots behind the UI Entry.
- `src/modules/web/`: `output-retention.ts` is the deep module (bounded previews, private
  temp-file retention with per-result and per-session quotas); `tool-shell.ts` is the shared
  execute wrapper; `search.ts` and `crawl.ts` hold provider-specific logic only.

### Shared Primitives, `src/shared/`

Cross-cutting code importable by every layer. Only files with two or more consuming Modules live
here. Code with one consumer lives in that consumer's Module, which is why the child AgentSession
runner, Manager, Profiles, prompt assets, result message, and Background Protocol all belong to
`src/modules/subagents/` (see ADR 0002).

`src/shared/lib/` is the generic library. It holds three files:

- `retained-output.ts`: quota-bounded spill storage (`RetainedOutputStore`) plus
  `composeBoundedOutput`, the single fixed-point composer that fits a truncated preview and its
  truncation notice inside one byte and line budget. Consumers: file-search, web, and UI transcript capture.
- `validate.ts`: record, error-message, and Unicode-safe bounded-string helpers. Consumers: every
  layer.
- `clock.ts`: the `Clock` interface (`now`, `setTimeout`, `clearTimeout`), `SYSTEM_CLOCK`, and
  `unrefTimer`. Any long-running owner that must be testable without real sleeps takes a `Clock`.
  Consumers today: file-search, the subagents Manager and Extension, and UI-owned queues.

## Boundary enforcement

`scripts/check-boundaries.ts` runs in `bun run check` and fails the gate on any edge outside the
layer rules. Its core is a pure function, `checkBoundaries(edges) -> violations`, fed by a
regex-based scanner that resolves every relative and `#` import under `src/`. Edge paths are
`src`-relative, so a file's layer is its first path segment. The rules:

- `app` may import `src/ui/start` (only that file of the UI), `pi-core`, and `shared`. It never
  imports a Module.
- `ui` may import `pi-core`, a Module's `interfaces/ui`, and `shared`.
- `pi-core` may import a Module's `interfaces/pi` and `shared`.
- A Module may import itself and `shared`, never another Module, not even through its Interfaces
  Directory.
- `shared` may import only `shared`.
- Outside a Module, only its Interfaces Directory is importable; a deep import into Module
  internals is a violation from any layer.
- Nothing imports `src/app/`.
- Production code may not import files outside the five source layers.

### Import spelling

An import is relative within a layer or Module and aliased across. The production aliases are Node
package subpath imports declared in `package.json` `"imports"`: `#app/*`, `#ui/*`, `#pi-core/*`,
`#modules/*`, and `#shared/*` map to `./src/<layer>/*`. The test-only `#test-support/*` alias maps to
`./test/support/*`. Bun, `bun build`, `tsc` (NodeNext), and Pi's own extension loader (jiti, which
the registration tests go through) all resolve them natively. tsconfig `paths` would not, because
jiti ignores it. The checker enforces
the spelling both ways: a relative import that crosses a layer or Module boundary is a violation,
a `#` alias that stays inside one is a violation, and a `#` specifier that does not match the
imports map is a violation. The payoff is that every cross-boundary edge is textually distinct from
an intra-module one: `grep '#shared/'` lists every consumer of the Shared Primitives.

The boundary scanner covers production code under `src/`. Tests, support files, and fixtures live
under `test/`, outside the layer graph. Test files import production code through the package
aliases. Bare specifiers (npm packages, the Pi SDK, `node:` and `bun:` builtins) and asset imports
are out of scope.

## Protocol ownership

Wire formats have exactly one implementation, owned by the producing Module, and consumers reach
parsed state through the Module's UI Entry instead of maintaining mirrors.

The one wire format today is the Background Protocol, owned by
`src/modules/subagents/protocol.ts`. The Extension publishes a complete active-Job array for its
session on `pi.subagents.jobs`; terminal Jobs leave that array and arrive separately as
`subagent-result` custom messages. `background-bridge.ts` validates the session route, bounds every
rendered string, and replaces the Controller's active set. The bridge is published through
`interfaces/ui.ts`. The protocol is an in-process observation seam, so it has no control channel,
version envelope, duplicated Job state, or Extension instance-authority reducer.

The UI treats extension payloads as untrusted input: the parser validates shape and routing, and
the view models bound every string.

## Dependency injection conventions

- Dependencies are passed as an options object with production defaults. The Register File
  resolves them explicitly; directly loaded Extensions construct the equivalent defaults. There
  are no module-level resource owners created as import side effects.
- Constructors are public. Tests build real objects with fake collaborators (fake
  `AgentSessionRuntime`, private `EventBus`, fake `MenuHost`, fake filesystem, fake child
  `AgentSession`, hand-advanced `Clock`) instead of casting through private APIs.
- Narrow seams are preferred over mocks: `MenuController` is a `Pick<>` of the controller, the web
  retention takes a `WebOutputRetentionFileSystem`, file-search takes `createCapture`, and the
  subagents Extension takes a runner factory and clock. There are no process-global child owners.

## Testing strategy

- Test at module boundaries. Pure modules (protocols, reducers, formatters, key predicates) are
  tested as functions. Stateful modules are driven through their public interface with injected
  fakes (`test/ui/state/controller.test.ts` binds a fake session and emits session events;
  `test/ui/components/menus.test.ts` drives `createMenus` with a fake host). The boundary checker's
  public interface is
  `checkBoundaries`, tested as a function from an import graph to a violation list.
- Timing is tested with an injected `Clock`, never real sleeps. The inactivity reset and hard Limit
  are exercised independently.
- The subagents runner is tested through a fake child `AgentSession`; file-search and web still run
  real bounded processes where the process or filesystem is their boundary.
- Bundled-skill tests materialize the real embedded assets and load the resulting path through
  Pi's public resource loader.
- `bun run check` is the gate: Biome, `tsc`, the boundary check, the full test suite
  (`bun test test`), a binary build, and a smoke test of the built executable.
  `scripts/smoke-build.ts` runs `dist/pui --help` and `dist/pui --smoke` and fails if any bundled
  tool (`fd`, `rg`, `explorer`, `worker`, `subagent_cancel`, `subagent_list`, `web_search`,
  `web_crawl`) or the `unslop` skill is missing from the printed JSON.

## Notes

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its
`CombinedAutocompleteProvider`; pui's visible renderer remains OpenTUI. Bundled resources augment
normal Pi discovery. Global and trusted project extensions and skills still load from Pi's regular
configuration. The three Extensions are built into pui and are not offered for standalone `pi` use.
