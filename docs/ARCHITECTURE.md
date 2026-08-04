# pui architecture

pui is a full-screen OpenTUI/Solid client for Pi. The codebase is organized around a small number of
deep modules: each hides significant machinery behind a narrow interface, receives its collaborators
through dependency injection with production defaults, and is tested at that interface.

```
src/index.tsx ── CLI entry: TUI | `pui workflow` (headless) | --workflow-smoke
      │
      ▼
src/controller.ts (PuiController) ──────────── deep module: embeds Pi, owns all state
      │  collaborators (each injectable):
      │    src/workflow-bridge.ts     WorkflowBridge      run map + control round-trips
      │    src/extension-dialogs.ts   ExtensionDialogQueue bounded dialog queue
      │    src/toasts.ts              ToastQueue          self-expiring notifications
      │    src/commands.ts            LOCAL_COMMANDS      one table: autocomplete + dispatch
      │
      ▼  immutable PuiSnapshot via subscribe()
src/app.tsx (App shell) + src/ui/* ─────────── view layer, renders snapshots only
      │
      ▼  extension factories (src/bundled-extensions.ts)
extensions/file-search  extensions/subagent  extensions/workflow  extensions/web
```

## Layers

### Entry — `src/index.tsx`

Parses CLI flags and dispatches: the interactive TUI (`PuiController.create` + Solid render),
`pui workflow …` (headless, via `src/headless-workflow.ts`, no TUI or Pi session), or the
compiled-binary smoke harness (`src/workflow-smoke.ts`, gated behind `PUI_WORKFLOW_SMOKE=1` but
statically linked so the built executable can self-test).

### Controller — `src/controller.ts`

`PuiController` is the single stateful hub. It embeds Pi through `AgentSessionRuntime`, rebinds on
every session replacement, reduces session/tool events into an immutable `PuiSnapshot`, and
publishes snapshots to subscribers with 16 ms coalescing. Everything the UI can do is a public
method on the controller.

Its constructor is public and takes `ControllerDependencies` — `eventBus`, `extensionFactories`,
and `readGitBranch` all have production defaults, so tests construct a controller against fake
runtimes and a private event bus without casts. `PuiController.create(options, dependencies?)` is
the production factory (session manager selection + runtime construction).

The controller delegates to focused collaborators rather than owning every concern:

| Module | Interface | Hides |
|---|---|---|
| `src/workflow-bridge.ts` | `bind / runs / inspect / control / dispose` | background-event parsing, the instance-authority reducer, control request/result correlation and timeout |
| `src/extension-dialogs.ts` | `request / resolve / current / dismissAll / close` | bounds on untrusted dialog content, abort signals, timeouts, FIFO queueing, kind-checked resolution |
| `src/toasts.ts` | `push / list / dispose` | TTL timers and the visible-toast cap |
| `src/commands.ts` | `LOCAL_COMMANDS`, `findLocalCommand` | the entire local slash-command surface — one entry per command drives autocomplete, aliases, and dispatch |

### View — `src/app.tsx` and `src/ui/`

`App` owns only UI state (prompt text, dialogs, completions, workflow page routing, keyboard
handling) and renders snapshots. Rendering and menu construction live in `src/ui/`:

| Module | Contents |
|---|---|
| `src/ui/menus.ts` | every picker/palette, built behind the `MenuHost` seam (`openDialog`, `openAsyncPicker`, a narrow `MenuController` slice of the controller) — pure data, unit-tested with fakes |
| `src/ui/dialogs.tsx` | `DialogState`, modal `Dialog` (picker / confirm / input / help) |
| `src/ui/transcript.tsx` | message, tool, subagent, bash, and summary cards |
| `src/ui/workflow-page.tsx` | the read-only workflow status page |
| `src/ui/prompt.tsx` | prompt textarea + autocomplete popover |
| `src/ui/sidebar.tsx` | session sidebar and toast stack |
| `src/ui/keys.ts` | all keyboard predicates: dismissal, enter detection, list cycling, prompt-history keys, extension-confirm intents (and the hint strings derived from them) |
| `src/ui/subagent-view.ts` | subagent presentation: status icons/labels/colors, elapsed, usage summaries |

Supporting view-adjacent modules stay in `src/`: `format.ts` (message → `DisplayItem` projection
with identity-preserving reconciliation), `tool-executions.ts` (tool lifecycle reducer),
`prompt-history.ts`, `prompt-autocomplete.ts` (text-position math), `selection-copy.ts`,
`focus-trap.ts`, `external-editor.ts`, `theme.ts`.

### Extensions — `extensions/`

Bundled, application-owned Pi extensions registered through `src/bundled-extensions.ts`. Each
`register*Extension(pi, dependencies = {})` takes an optional dependency bag with production
defaults — the same DI convention as the controller.

- `extensions/file-search/` — `fd`/`rg` tools. `process.ts` is the deep module: `runFileSearch`
  hides shell-free spawning, process-group kill, timeouts, and bounded output capture with
  temp-file spill (capture creation is an injectable seam). `args.ts` builds argv, `binaries.ts`
  resolves system binaries (also used by the controller for `@` completion).
- `extensions/subagent/` — child-Pi subagents. `protocol.ts` owns the versioned `pi.subagent` wire
  format (types, transitions, validator); `runner.ts` spawns and supervises one child;
  `run-job.ts` is the single run pipeline (queueing, semaphore, spawn, terminal synthesis, output
  spill) shared by the blocking tool and the background manager; `background-manager.ts` owns
  background-job delivery semantics; `background-protocol.ts` owns the background bus envelopes;
  `presets.ts`/`semaphore.ts` are shared with the workflow extension.
- `extensions/workflow/` — programmatic workflows. `backend.ts` (run lifecycle + sandboxed worker
  supervision; collaborators are injectable through an options bag, including a `WorkflowPlatform`
  seam for timings/uuid/log/worker source and a `WorkflowRunStore` storage interface),
  `worker-protocol.ts` (untrusted worker-frame validation and NDJSON decoding),
  `worker-source.ts` + `worker/*.js.txt` (the sandboxed worker and bootstrap sources as text
  imports), `rpc-operations.ts` (pure request/result validators and the one durable-operation
  pipeline behind shell/agent RPCs), `run-storage.ts` (durable run directories),
  `durable-fs.ts` (shared atomic-write/fsync and the cross-process directory-lock protocol with
  per-caller policies), `source.ts` (workflow file parsing), `js-scan.ts` (the one JavaScript
  tokenizer shared by preflight and source parsing), `approval.ts` (cross-process approval store),
  `session-lifecycle.ts` (session epoch/generation guards for `index.ts`), `worktree.ts`,
  `manager.ts`, `protocol.ts` + `background-protocol.ts` (wire formats). `agent-executor.ts`
  provides the default child-Pi agent executor and the shared production backend wiring used by
  the extension, the headless CLI, and the smoke harness.
- `extensions/shared/` — cross-extension primitives: `bounded-process.ts` (`runBoundedProcess`
  spawn/timeout/kill with bounded output; `killProcessTree` group signaling used by every child
  supervisor).
- `extensions/web/` — `web_search`/`web_crawl`. `output-retention.ts` is the deep module (bounded
  previews, private temp-file retention with per-result/per-session quotas); `tool-shell.ts` is the
  shared execute wrapper; `search.ts`/`crawl.ts` hold provider-specific logic only.

## Protocol ownership

Wire formats have exactly one implementation, owned by the producing extension:

- `extensions/subagent/protocol.ts` — `pi.subagent` details. `src/subagent.ts` consumes it: it
  validates with the extension's `isSubagentDetailsV1` and then bounds every string into a
  `SubagentViewModel` safe for rendering and reconciliation.
- `extensions/subagent/background-protocol.ts` — background-subagent bus channels.
  `src/background-subagent.ts` re-exports the channel constants and reduces events into the
  snapshot's job map.
- `extensions/workflow/protocol.ts` + `background-protocol.ts` — workflow summaries, background
  events, and control envelopes. `src/workflow-bridge.ts` consumes the parsers and owns only the
  host-side reducer (instance authority, run cap) and control correlation.

The host still treats extension payloads as untrusted input: parsers validate shape and routing,
and the view models bound every string.

## Dependency injection conventions

- Dependencies are passed as an options object with production defaults; there are no
  module-level singletons that construct resources at import time.
- Constructors are public. Tests build real objects with fake collaborators (fake
  `AgentSessionRuntime`, private `EventBus`, fake `MenuHost`, fake filesystem) instead of casting
  through private APIs.
- Narrow seams are preferred over mocks: `MenuController` is a `Pick<>` of the controller, the web
  retention takes a `WebOutputRetentionFileSystem`, file-search takes `createCapture`, the workflow
  extension accepts a whole `backend`.
- One deliberate exception: the subagent extension caches its process-wide concurrency semaphore on
  `globalThis` so a duplicated module instance still shares one limit.

## Testing strategy

- Test at module boundaries. Pure modules (protocols, reducers, formatters, key predicates) are
  tested as functions. Stateful modules are driven through their public interface with injected
  fakes (`controller.test.ts` binds a fake session and emits session events; `menus.test.ts`
  drives `createMenus` with a fake host).
- Where the real boundary is a process or the filesystem, tests use the real thing: the subagent
  runner spawns a fixture child, the approval store races a real second process, worktree tests run
  real `git`, run-storage tests inject real corruption.
- `bun run check` is the gate: Biome, `tsc`, the full test suite, a binary build, and a smoke test
  of the built executable (`scripts/smoke-build.ts` → `dist/pui --workflow-smoke`).

## Notes

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its
`CombinedAutocompleteProvider`; pui's visible renderer remains OpenTUI. Bundled extensions augment
normal Pi discovery — global and trusted project extensions still load from Pi's regular
configuration, and the bundled extensions stay loadable in plain `pi` via `pi -e`.
