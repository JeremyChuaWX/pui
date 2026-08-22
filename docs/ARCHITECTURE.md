# pui architecture

pui is a full-screen OpenTUI/Solid client for Pi. The source under `src/` is organized into five
top-level layers. Each feature is a self-contained Module whose only importable surface is its Interfaces
Directory, every dependency edge points one way, and a boundary check in `bun run check` enforces
the edges. Within each layer the design favors deep modules: significant machinery hidden behind a
narrow interface, collaborators injected through an options bag with production defaults, tests
written at that interface.

The vocabulary used here (Module, Extension, Pi Core, App, Controller, Register File, Shared
Primitive, Child-Agent Runtime, Agent Role, Interfaces Directory, Host Entry, UI Entry) is defined
in the glossary in `CONTEXT.md`. Docs and code comments keep to it.

## The five layers

```
src/app/       entry points + pui process management
  ├──▶ src/ui/start.tsx                    the UI's single start function
  ├──▶ src/pi-core/                        bundled skills for the smoke harness
  └──▶ src/modules/*/interfaces/host.ts    Host Entries (headless workflow runs)

src/ui/        ui/state (the Controller) + ui/components (OpenTUI/Solid views)
  ├──▶ src/pi-core/                        extension factories + bundled skills
  └──▶ src/modules/*/interfaces/ui.ts      UI Entries (parsed view state)

src/pi-core/   the Register File + bundled skills
  └──▶ src/modules/*/interfaces/pi.ts      Extensions

src/modules/   file-search   web   subagents   workflows
  └──▶ src/shared/ only — never another Module

src/shared/    Shared Primitives: agent-runtime (the Child-Agent Runtime) + lib
  └──▶ src/shared/ only
```

`src/shared/` is importable from every layer; nothing imports `src/app/`. The `"pui/workflow"` package
export resolves to `src/modules/workflows/interfaces/api.ts` and is consumed by workflow scripts, not
by any layer. Two entries in `src/` sit outside the diagram: `src/test-support/` (test-only helpers
that production code may not import) and `src/assets.d.ts` (ambient declarations for bundled
text/Markdown assets). Everything else at the repo root is not source: `scripts/` holds the build,
smoke-test, and boundary-check scripts, `docs/` and `issues/` hold documentation, and `.pui/` holds
sample workflow scripts.

### App — `src/app/`

`src/app/index.tsx` parses CLI flags and dispatches. Each dispatch target is imported lazily, so the
interactive path never loads the workflow CLI and the headless path never loads the UI:

- the interactive TUI, via `startUi` in `src/ui/start.tsx` — the UI's single start function, which
  creates the controller and renderer and mounts the Solid shell;
- `pui workflow …`, via `src/app/headless-workflow.ts`, which imports only the workflows Module's Host
  Entry (`src/modules/workflows/interfaces/host.ts`) — no UI code, no TUI, no Pi session;
- the compiled-binary smoke harness `src/app/workflow-smoke.ts`, gated behind `PUI_WORKFLOW_SMOKE=1`
  but statically linked so the built executable can self-test.

A prompt argument is handed to the App as `initialPrompt` and dispatched through the same
prompt-action record as interactive input, so command-line slash invocations (`pui "/models"`)
perform their action.

### UI — `src/ui/`

The UI is two directories plus the start function: `src/ui/state/` (the Controller and its state
collaborators), `src/ui/components/` (the OpenTUI/Solid views), and `src/ui/start.tsx` (renderer creation
and mounting). The UI reaches features only through Module UI Entries
(`src/modules/*/interfaces/ui.ts`), never feature protocol files.

#### Controller — `src/ui/state/controller.ts`

`PuiController` is the single stateful hub. It embeds Pi through `AgentSessionRuntime`, rebinds on
every session replacement, reduces session/tool events into an immutable `PuiSnapshot`, and
publishes snapshots to subscribers with 16 ms coalescing. Everything the UI can do is a public
method on the controller.

Its constructor is public and takes `ControllerDependencies` — `eventBus`, `extensionFactories`,
and `readGitBranch` all have production defaults, so tests construct a controller against fake
runtimes and a private event bus without casts. `PuiController.create(options, dependencies?)` is
the production factory (session manager selection + runtime construction).

The controller delegates to focused collaborators rather than owning every concern:

| Collaborator | Interface | Hides |
|---|---|---|
| `src/modules/workflows/interfaces/ui.ts` | `WorkflowBridge` (`bind / runs / inspect / control / dispose`) | workflow background-event parsing and control correlation |
| `src/modules/subagents/interfaces/ui.ts` | `BackgroundSubagentBridge` | extension-owned event parsing, bounded host view models, and cancellation routing |
| `src/modules/file-search/interfaces/ui.ts` | `fdCompletionCommand` | system `fd`/`fdfind` resolution for `@` file completion |
| `src/shared/lib/instance-scoped-runs.ts` | `InstanceScopedRuns<T>` reducer | routed producer authority, copy-on-write run maps, reset/replacement gating, and caps shared by both bridges |
| `src/ui/state/controller-queues.ts` | `ExtensionDialogQueue`, `ToastQueue` | bounded extension dialogs, aborts/timeouts/FIFO resolution, and self-expiring notifications |

The controller's command descriptor list is the single source for slash-command autocomplete,
aliases, dispatch, and the command palette: palette rows (including palette-only entries) live on
the same descriptors, `src/ui/components/menus.ts` renders them rank-sorted and binds each row's action
through an exhaustive record, so the two surfaces cannot drift.

The controller's remaining state collaborators live beside it in `src/ui/state/`: `format.ts`
(message → `DisplayItem` projection with identity-preserving reconciliation), `tool-executions.ts`
(tool lifecycle reducer), `types.ts` (shared view types), and `prompt-autocomplete.ts`
(text-position math).

#### Components — `src/ui/components/`

`App` (`src/ui/components/app.tsx`) owns only UI state (prompt text, dialogs, completions, workflow
page routing, keyboard handling) and renders snapshots:

| File | Contents |
|---|---|
| `src/ui/components/menus.ts` | every picker/palette, built behind the `MenuHost` seam (`openDialog`, `openAsyncPicker`, a narrow `MenuController` slice of the controller) — pure data, unit-tested with fakes |
| `src/ui/components/dialogs.tsx` | `DialogState`, modal `Dialog` (picker / confirm / input / help), and the pure `extensionDialogState` derivation from extension dialog requests |
| `src/ui/components/transcript.tsx` | message, tool, subagent, bash, and summary cards |
| `src/ui/components/workflow-page.tsx` | the read-only workflow status page |
| `src/ui/components/prompt.tsx` | prompt textarea + autocomplete popover |
| `src/ui/components/sidebar.tsx` | session sidebar and toast stack |
| `src/ui/components/keys.ts` | all keyboard knowledge: the global shortcut table (one entry per binding drives `globalKeyIntent` dispatch in the app and the Help dialog's `globalKeyHelp` lines), `listNavigationDirection` list cycling, dismissal, enter detection, prompt-history keys, extension-confirm intents (and the hint strings derived from them) |
| `src/ui/components/subagent-view.ts` | subagent presentation: status icons/labels/colors, elapsed, usage summaries |
| `src/ui/components/workflow-view.ts` | workflow presentation (status icons/labels/tones, run summaries) and the pure `resolveWorkflowNavigation` routing for pending workflow-page navigation |

View-side helpers `app-support.ts` (prompt history, selection copy, focus trapping, external
editor) and `theme.ts` also live in `src/ui/components/`.

### Pi Core — `src/pi-core/`

Pi Core owns registration. Bundled, application-owned Pi extensions are wired by the Register File,
the single composition root in `src/pi-core/register.ts`. Pi Core imports nothing from a Module except
its Extension (`interfaces/pi.ts`), plus shared. `createBundledExtensionFactories(options?)`
explicitly supplies every production collaborator (including resource owners), while accepting
per-extension fake bags for boundary tests; `BUNDLED_EXTENSION_FACTORIES` is its production result.
Each `register*Extension(pi, dependencies = {})` retains options-bag DI, and each Extension's
default export — the module shape Pi's extension loader expects — calls a small
`createDefault*Dependencies` helper with the same production wiring; the registration tests load
the Extensions through Pi's own resource loader to prove it. The Extensions are built into pui and
are not offered for standalone `pi -e` use.

`src/pi-core/skills/unslop/` contains the bundled writing skill and its upstream MIT license.
`src/pi-core/bundled-skills.ts` imports both with Bun's file loader, then copies them to a private
temporary directory owned by the controller. This gives Pi and its tools ordinary filesystem paths
instead of Bun's `$bunfs` paths, which `fs.readFile` can read but `fs.access` cannot. The runtime
supplies the copied `SKILL.md` through `additionalSkillPaths`, alongside Pi's normal global and
trusted project discovery, and removes the temporary directory during controller disposal.

### Modules — `src/modules/`

Each feature lives in one directory under `src/modules/`. A Module owns its logic, state, and wire
protocols; Modules never import each other and may import only `src/shared/` (plus npm and the Pi
SDK). From outside a Module, only its Interfaces Directory (`src/modules/<name>/interfaces/`) is
importable; everything else is private. The entry names are fixed, and each entry is consumed by
exactly one layer:

| Entry | Consumer | Role |
|---|---|---|
| `interfaces/pi.ts` | Pi Core's Register File | the Extension. Required; its default export is Pi's extension-module shape. Built into pui, not a standalone `pi` extension |
| `interfaces/host.ts` | the App | the Host Entry: host-process needs such as headless runs |
| `interfaces/ui.ts` | the UI | the UI Entry: view models, protocol parsers, and bridges — the only way UI code reaches the Module |
| `interfaces/api.ts` | workflow scripts | the public authoring SDK behind the `"pui/workflow"` package export |

What each Module publishes:

| Module | `pi` | `host` | `ui` | `api` |
|---|---|---|---|---|
| `file-search` | `fd`/`rg` tools | — | the `@`-completion command | — |
| `web` | `web_search`/`web_crawl` | — | — | — |
| `subagents` | `subagent` + background tools | reserved (documented empty stub) | bounded subagent view models + `BackgroundSubagentBridge` | — |
| `workflows` | the `workflow` tool | headless run path + backend/manager/storage for the smoke harness | `WorkflowBridge`, the run-event reducer, `resolveWorkflowRun` | type-only `"pui/workflow"` SDK |

Inside their private files, the Modules are deep:

- `src/modules/file-search/` — `process.ts` is the deep module: `runFileSearch` hides shell-free
  spawning, process-group kill, timeouts, and bounded output capture with temp-file spill (capture
  creation is an injectable seam). `args.ts` builds argv, `binaries.ts` resolves system binaries.
- `src/modules/subagents/` — `protocol.ts` owns the versioned `pi.subagent` wire format (types,
  transitions, validator); `runner.ts` is a thin adapter that folds Child-Agent Runtime events into
  `SubagentDetailsV1` snapshots; `run-job.ts` is the single run pipeline (queueing, semaphore,
  spawn, terminal synthesis, output spill) shared by the blocking tool and the background manager;
  `background-manager.ts` owns background-job delivery semantics; `background-protocol.ts` owns the
  background bus envelopes; `view-model.ts` and `background-bridge.ts` bound protocol payloads into
  host view models behind the UI Entry.
- `src/modules/workflows/` — `backend.ts` (run lifecycle and active-run state; collaborators are
  injectable through an options bag, including a `WorkflowPlatform` seam for
  timings/uuid/log/worker source and a `WorkflowRunStore` storage interface), `preflight.ts`
  (launch-time script vetting), `node-resolution.ts` (sandbox Node discovery and the default host
  shell executor), `worker-host.ts` (`WorkflowWorker`: sandboxed spawn, frame decoding, stderr
  tail, and watchdog/timeout supervision of one worker process), `rpc-handler.ts` (the
  phase/log/shell/agent RPC dispatch and reply framing for one run), `worker-protocol.ts` +
  `worker/*.js.txt` (untrusted worker-frame validation, NDJSON decoding, and sandboxed worker
  source), `rpc-operations.ts` (pure request/result validators and the one durable-operation
  pipeline behind shell/agent RPCs), `run-storage.ts` (durable run directories), `durable-fs.ts`
  (safe-directory traversal, atomic-write/fsync, and the cross-process directory-lock protocol
  with per-caller policies), `source.ts` (workflow file parsing), `js-scan.ts` (the one JavaScript
  tokenizer shared by preflight and source parsing), `approval.ts` (cross-process approval store),
  `session-lifecycle.ts` (session epoch/generation guards for the Extension), `worktree.ts`,
  `manager.ts`, `protocol.ts` (run and background wire formats). `agent-executor.ts` provides the
  default child-Pi agent executor — a thin adapter over the Child-Agent Runtime — and the shared
  production backend wiring used by the Extension, the headless CLI, and the smoke harness. The
  default policy's role allowlist, model resolution, and per-role timeout defaults all derive from
  the Agent Roles in `src/shared/agent-runtime/presets.ts`, the single role definition.
- `src/modules/web/` — `output-retention.ts` is the deep module (bounded previews, private temp-file
  retention with per-result/per-session quotas); `tool-shell.ts` is the shared execute wrapper;
  `search.ts`/`crawl.ts` hold provider-specific logic only.

### Shared Primitives — `src/shared/`

Cross-cutting code importable by every layer, split in two so that reaching for a validator does
not entangle a Module with agent-spawning machinery:

- `src/shared/agent-runtime/` — the Child-Agent Runtime: `child-agent.ts` (the one child-Pi runtime:
  shell-free detached spawn, NDJSON parsing into throttled neutral `ChildAgentEvent` flushes,
  bounded stderr, usage aggregation with fingerprint dedupe, model-label canonicalization,
  terminal-status classification, SIGTERM→SIGKILL termination, and the process-wide child-Pi
  semaphore; the subagent runner and the workflow agent executor are both adapters over it) and
  `presets.ts` (the Agent Roles: `worker`/`explore`/`generic` child-agent presets, the single role
  allowlist, and the model/timeout resolution used by both subagents and workflows; the bundled
  agent guidance lives in `src/shared/agent-runtime/agents/`). Agent Roles belong here, not to the
  subagents Module — see ADR 0001 in `docs/adr/`.
- `src/shared/lib/` — the generic library: `background-channel.ts` (producer-side
  ready/subscribe/route-guard/reset/shutdown wiring with injected protocol parsers and event APIs),
  `bounded-process.ts` (`runBoundedProcess` spawn/timeout/kill with bounded output;
  `createGracefulTermination` SIGTERM→SIGKILL escalation and `killProcessTree` group signaling
  used by every child supervisor), `instance-scoped-runs.ts` (the routed copy-on-write run-set
  reducer — producer authority, reset/replacement gating, and run caps — shared by the subagent
  and workflow bridges), `json-events.ts` (the JSONL splitter for child NDJSON streams),
  `retained-output.ts` (quota-bounded spill storage plus `composeBoundedOutput`, the single
  fixed-point composer that fits a truncated preview and its accurate truncation notice inside one
  byte/line budget for every extension), `semaphore.ts` (abort-aware FIFO concurrency), and
  `validate.ts` (record, error-message, and Unicode-safe bounded-string helpers).

## Boundary enforcement

`scripts/check-boundaries.ts` runs in `bun run check` and fails the gate on any edge outside the
layer rules. Its core is a pure function, `checkBoundaries(edges) -> violations`, fed by a
regex-based scanner that resolves every relative and `#` import under `src/`; edge paths are
`src`-relative, so a file's layer is its first path segment. The rules:

- `app` may import `src/ui/start` (only that file of the UI), `pi-core`, a Module's `interfaces/host`,
  and `shared`.
- `ui` may import `pi-core`, a Module's `interfaces/ui`, and `shared`.
- `pi-core` may import a Module's `interfaces/pi` and `shared`.
- A Module may import itself and `shared` — never another Module, not even through its Interfaces
  Directory.
- `shared` may import only `shared`.
- Outside a Module, only its Interfaces Directory is importable; a deep import into Module
  internals is a violation from any layer.
- Nothing imports `src/app/`.
- Production code may not import test files or `test-support/`.

### Import spelling

An import is **relative within a layer or Module and aliased across**. The aliases are Node package
subpath imports declared in `package.json` `"imports"` — `#app/*`, `#ui/*`, `#pi-core/*`,
`#modules/*`, `#shared/*`, `#test-support/*` → `./src/<layer>/*` — which Bun, `bun build`, `tsc`
(NodeNext), and Pi's own extension loader (jiti, which the registration tests go through) all
resolve natively. (tsconfig `paths` would not: jiti ignores it.) The checker enforces the spelling both ways: a
relative import that crosses a layer or Module boundary is a violation, a `#` alias that stays
inside one is a violation, and a `#` specifier that does not match the imports map is a violation.
The spelling rule also applies to test files, which are otherwise exempt. The payoff is that every
cross-boundary edge is textually distinct from an intra-module one: `grep '#shared/'` lists every
consumer of the Shared Primitives.

The layer rules cover production code only: `*.test.ts(x)` files and `test-support/` directories are
exempt as import sources (module tests use `src/test-support/`, and
`src/pi-core/register.test.ts` drives the UI controller). Bare specifiers (npm packages, the Pi SDK,
`node:`/`bun:` builtins) and asset imports are out of scope.

## Protocol ownership

Wire formats have exactly one implementation, owned by the producing Module, and consumers reach
parsed state through the Module's UI Entry instead of maintaining mirrors:

- `src/modules/subagents/protocol.ts` — `pi.subagent` details. The Module's `view-model.ts` consumes
  it: it validates with `isSubagentDetailsV1` and then bounds every string into a
  `SubagentViewModel` safe for rendering and reconciliation, published through `interfaces/ui.ts`.
- `src/modules/subagents/background-protocol.ts` — background-subagent bus channels. The Module's
  `background-bridge.ts` consumes its parser, bounds strings into host view models, and exposes a
  bridge that owns instance authority, subscription lifecycle, cancellation, and the job map,
  published through `interfaces/ui.ts`.
- `src/modules/workflows/protocol.ts` — workflow summaries, background events, and control envelopes.
  The Module's `bridge.ts` consumes the parsers and owns control correlation, and `view-model.ts`
  resolves tool-result details against authoritative runs, both published through
  `interfaces/ui.ts`. Both bridges delegate instance authority, routed copy-on-write updates,
  reset/replacement gating, and run caps to `src/shared/lib/instance-scoped-runs.ts`.

The UI still treats extension payloads as untrusted input: parsers validate shape and routing, and
the view models bound every string.

## Dependency injection conventions

- Dependencies are passed as an options object with production defaults. The Register File
  resolves them explicitly; directly loaded Extensions construct the equivalent defaults. There
  are no module-level resource owners created as import side effects.
- Constructors are public. Tests build real objects with fake collaborators (fake
  `AgentSessionRuntime`, private `EventBus`, fake `MenuHost`, fake filesystem) instead of casting
  through private APIs.
- Narrow seams are preferred over mocks: `MenuController` is a `Pick<>` of the controller, the web
  retention takes a `WebOutputRetentionFileSystem`, file-search takes `createCapture`, the
  workflow Extension accepts a whole `backend`.
- One deliberate exception: the Child-Agent Runtime caches its process-wide semaphore on
  `globalThis` so a duplicated module instance still shares one concurrency limit. Subagents and
  workflow agents draw from the same slots.

## Testing strategy

- Test at module boundaries. Pure modules (protocols, reducers, formatters, key predicates) are
  tested as functions. Stateful modules are driven through their public interface with injected
  fakes (`controller.test.ts` binds a fake session and emits session events; `menus.test.ts`
  drives `createMenus` with a fake host). The boundary checker's public interface is
  `checkBoundaries`, tested as a function from an import graph to a violation list.
- Where the real boundary is a process or the filesystem, tests use the real thing: the
  Child-Agent Runtime and the subagent runner spawn a fixture child, the approval store races a
  real second process, worktree tests run real `git`, run-storage tests inject real corruption.
- Bundled-skill tests materialize the real embedded assets and load the resulting path through
  Pi's public resource loader. The compiled executable smoke test verifies that `fs.access` and
  reads work against those ordinary files.
- `bun run check` is the gate: Biome, `tsc`, the boundary check, the full test suite
  (`bun test src scripts`), a binary build, and a smoke test of the
  built executable (`scripts/smoke-build.ts` → `dist/pui --workflow-smoke`).

## Notes

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its
`CombinedAutocompleteProvider`; pui's visible renderer remains OpenTUI. Bundled resources augment
normal Pi discovery. Global and trusted project extensions and skills still load from Pi's regular
configuration. The four Extensions are built into pui and are not offered for standalone `pi` use.
