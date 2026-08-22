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
      │    modules/workflows/interfaces/ui.ts  WorkflowBridge      run map + control round-trips
      │    modules/subagents/interfaces/ui.ts  BackgroundSubagentBridge + bounded view models
      │    src/controller-queues.ts   ExtensionDialogQueue / ToastQueue
      │
      ▼  immutable PuiSnapshot via subscribe()
src/app.tsx (App shell) + src/ui/* ─────────── view layer, renders snapshots only
      │
      ▼  bundled resources
extension factories (pi-core/register.ts)  skill paths (pi-core/bundled-skills.ts)
modules/file-search  modules/web  modules/subagents  modules/workflows  pi-core/skills/unslop
```

## Layers

### Entry — `src/index.tsx`

Parses CLI flags and dispatches: the interactive TUI (`PuiController.create` + Solid render),
`pui workflow …` (headless, via the workflows Module's Host Entry `modules/workflows/interfaces/host.ts`, no TUI or Pi session), or the
compiled-binary smoke harness (`src/workflow-smoke.ts`, gated behind `PUI_WORKFLOW_SMOKE=1` but
statically linked so the built executable can self-test). A prompt argument is handed to the App as
`initialPrompt` and dispatched through the same prompt-action record as interactive input, so
command-line slash invocations (`pui "/models"`) perform their action.

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
| `modules/workflows/interfaces/ui.ts` | `WorkflowBridge` (`bind / runs / inspect / control / dispose`) | workflow background-event parsing and control correlation |
| `modules/subagents/interfaces/ui.ts` | `BackgroundSubagentBridge` | extension-owned event parsing, bounded host view models, and cancellation routing |
| `shared/lib/instance-scoped-runs.ts` | `InstanceScopedRuns<T>` reducer | routed producer authority, copy-on-write run maps, reset/replacement gating, and caps shared by both bridges |
| `src/controller-queues.ts` | `ExtensionDialogQueue`, `ToastQueue` | bounded extension dialogs, aborts/timeouts/FIFO resolution, and self-expiring notifications |

The controller's command descriptor list is the single source for slash-command autocomplete,
aliases, dispatch, and the command palette: palette rows (including palette-only entries) live on
the same descriptors, `src/ui/menus.ts` renders them rank-sorted and binds each row's action through
an exhaustive record, so the two surfaces cannot drift.

### View — `src/app.tsx` and `src/ui/`

`App` owns only UI state (prompt text, dialogs, completions, workflow page routing, keyboard
handling) and renders snapshots. Rendering and menu construction live in `src/ui/`:

| Module | Contents |
|---|---|
| `src/ui/menus.ts` | every picker/palette, built behind the `MenuHost` seam (`openDialog`, `openAsyncPicker`, a narrow `MenuController` slice of the controller) — pure data, unit-tested with fakes |
| `src/ui/dialogs.tsx` | `DialogState`, modal `Dialog` (picker / confirm / input / help), and the pure `extensionDialogState` derivation from extension dialog requests |
| `src/ui/transcript.tsx` | message, tool, subagent, bash, and summary cards |
| `src/ui/workflow-page.tsx` | the read-only workflow status page |
| `src/ui/prompt.tsx` | prompt textarea + autocomplete popover |
| `src/ui/sidebar.tsx` | session sidebar and toast stack |
| `src/ui/keys.ts` | all keyboard knowledge: the global shortcut table (one entry per binding drives `globalKeyIntent` dispatch in the app and the Help dialog's `globalKeyHelp` lines), `listNavigationDirection` list cycling, dismissal, enter detection, prompt-history keys, extension-confirm intents (and the hint strings derived from them) |
| `src/ui/subagent-view.ts` | subagent presentation: status icons/labels/colors, elapsed, usage summaries |
| `src/ui/workflow-view.ts` | workflow presentation (status icons/labels/tones, run summaries) and the pure `resolveWorkflowNavigation` routing for pending workflow-page navigation |

Supporting view-adjacent modules stay in `src/`: `format.ts` (message → `DisplayItem` projection
with identity-preserving reconciliation), `tool-executions.ts` (tool lifecycle reducer),
`app-support.ts` (prompt history, selection copy, focus trapping, external editor),
`prompt-autocomplete.ts` (text-position math), and `theme.ts`.

### Pi Core — `pi-core/` — and the Modules — `modules/`

The shared ambient declarations for bundled text/Markdown assets live in `extensions/assets.d.ts`.

Bundled, application-owned Pi extensions are wired by Pi Core's Register File, the real composition
root in `pi-core/register.ts`. Pi Core imports nothing from a Module except its Extension
(`interfaces/pi.ts`), plus shared. `createBundledExtensionFactories(options?)` explicitly supplies every
production collaborator (including resource owners), while accepting per-extension fake bags for
boundary tests; `BUNDLED_EXTENSION_FACTORIES` is its production result. Each
`register*Extension(pi, dependencies = {})` retains options-bag DI, and each extension's default
export calls a small `createDefault*Dependencies` helper so the source remains directly loadable by
plain Pi with equivalent production wiring.

- `modules/file-search/` — `fd`/`rg` tools, a feature Module whose only importable surface is
  `interfaces/pi.ts` (the Extension) and `interfaces/ui.ts` (the `@`-completion surface the
  controller consumes). `process.ts` is the deep module: `runFileSearch` hides shell-free
  spawning, process-group kill, timeouts, and bounded output capture with temp-file spill
  (capture creation is an injectable seam). `args.ts` builds argv, `binaries.ts` resolves
  system binaries.
- `modules/subagents/` — child-Pi subagents, a feature Module whose only importable surface is
  `interfaces/pi.ts` (the Extension), `interfaces/ui.ts` (the parsed subagent state the controller
  and views consume), and `interfaces/host.ts` (reserved; no host-side needs today). `protocol.ts`
  owns the versioned `pi.subagent` wire format (types, transitions, validator); `runner.ts` is a
  thin adapter that folds shared child-agent runtime events into `SubagentDetailsV1` snapshots;
  `run-job.ts` is the single run pipeline (queueing, semaphore, spawn, terminal synthesis, output
  spill) shared by the blocking tool and the background manager; `background-manager.ts` owns
  background-job delivery semantics; `background-protocol.ts` owns the background bus envelopes;
  `view-model.ts` and `background-bridge.ts` bound protocol payloads into host view models behind
  the UI Entry.
- `modules/workflows/` — programmatic workflows, a feature Module whose only importable surface is
  `interfaces/pi.ts` (the Extension), `interfaces/host.ts` (the Host Entry: the headless run path
  plus the backend/manager/storage exports the compiled-binary smoke harness uses),
  `interfaces/ui.ts` (the UI Entry: `WorkflowBridge`, the run-event reducer, and
  `resolveWorkflowRun`, the parsed run state the controller and views consume), and
  `interfaces/api.ts` (the type-only authoring SDK behind the `"pui/workflow"` package export).
  Inside the Module: `backend.ts` (run lifecycle and active-run
  state; collaborators are injectable through an options bag, including a `WorkflowPlatform`
  seam for timings/uuid/log/worker source and a `WorkflowRunStore` storage interface),
  `preflight.ts` (launch-time script vetting), `node-resolution.ts` (sandbox Node discovery and
  the default host shell executor), `worker-host.ts` (`WorkflowWorker`: sandboxed spawn, frame
  decoding, stderr tail, and watchdog/timeout supervision of one worker process),
  `rpc-handler.ts` (the phase/log/shell/agent RPC dispatch and reply framing for one run),
  `worker-protocol.ts` + `worker/*.js.txt` (untrusted worker-frame validation, NDJSON decoding,
  and sandboxed worker source), `rpc-operations.ts` (pure request/result validators and the one
  durable-operation pipeline behind shell/agent RPCs), `run-storage.ts` (durable run directories),
  `durable-fs.ts` (safe-directory traversal, atomic-write/fsync, and the cross-process directory-lock protocol with
  per-caller policies), `source.ts` (workflow file parsing), `js-scan.ts` (the one JavaScript
  tokenizer shared by preflight and source parsing), `approval.ts` (cross-process approval store),
  `session-lifecycle.ts` (session epoch/generation guards for `interfaces/pi.ts`), `worktree.ts`,
  `manager.ts`, `protocol.ts` (run and background wire formats). `agent-executor.ts`
  provides the default child-Pi agent executor — a thin adapter over the shared child-agent
  runtime — and the shared production backend wiring used by
  the extension, the headless CLI, and the smoke harness. The default policy's role allowlist,
  model resolution, and per-role timeout defaults all derive from the presets in
  `shared/agent-runtime/presets.ts`, the single role definition.
- `modules/web/` — `web_search`/`web_crawl`, a feature Module whose only importable surface is
  `interfaces/pi.ts` (the Extension). `output-retention.ts` is the deep module (bounded
  previews, private temp-file retention with per-result/per-session quotas); `tool-shell.ts` is the
  shared execute wrapper; `search.ts`/`crawl.ts` hold provider-specific logic only.

### Shared Primitives — `shared/`

Cross-cutting primitives importable by every layer, split in two:

- `shared/agent-runtime/` — the Child-Agent Runtime: `child-agent.ts` (the one child-Pi runtime:
  shell-free detached spawn, NDJSON parsing into throttled neutral `ChildAgentEvent` flushes,
  bounded stderr, usage aggregation with fingerprint dedupe, model-label canonicalization,
  terminal-status classification, SIGTERM→SIGKILL termination, and the process-wide child-Pi
  semaphore; the subagent runner and the workflow agent executor are both adapters over it) and
  `presets.ts` (the Agent Roles: child-agent presets, the single role allowlist, and model/timeout
  resolution used by subagents and workflows; the bundled agent guidance lives in
  `shared/agent-runtime/agents/`). Agent Roles belong here, not to the subagent extension — see
  ADR 0001 in `docs/adr/`.
- `shared/lib/` — the generic library: `background-channel.ts` (producer-side
  ready/subscribe/route-guard/reset/shutdown wiring with injected protocol parsers and event APIs),
  `bounded-process.ts` (`runBoundedProcess` spawn/timeout/kill with bounded output;
  `createGracefulTermination` SIGTERM→SIGKILL escalation and
  `killProcessTree` group signaling used by every child supervisor), `instance-scoped-runs.ts`
  (the routed copy-on-write run-set reducer — producer authority, reset/replacement gating, and
  run caps — shared by the subagent and workflow bridges), `json-events.ts` (the JSONL
  splitter for child NDJSON streams), `retained-output.ts` (quota-bounded
  spill storage plus `composeBoundedOutput`, the single fixed-point composer that fits a truncated
  preview and its accurate truncation notice inside one byte/line budget for every extension),
  `semaphore.ts` (abort-aware FIFO concurrency), and `validate.ts`
  (record, error-message, and Unicode-safe bounded-string helpers).

### Skills — `pi-core/skills/`

`pi-core/skills/unslop/` contains the bundled writing skill and its upstream MIT license. `pi-core/bundled-skills.ts`
imports both with Bun's file loader, then copies them to a private temporary directory owned by the
controller. This gives Pi and its tools ordinary filesystem paths instead of Bun's `$bunfs` paths,
which `fs.readFile` can read but `fs.access` cannot. The runtime supplies the copied `SKILL.md` through
`additionalSkillPaths`, alongside Pi's normal global and trusted project discovery, and removes the
temporary directory during controller disposal.

## Protocol ownership

Wire formats have exactly one implementation, owned by the producing extension:

- `modules/subagents/protocol.ts` — `pi.subagent` details. The Module's `view-model.ts` consumes
  it: it validates with `isSubagentDetailsV1` and then bounds every string into a
  `SubagentViewModel` safe for rendering and reconciliation, published through `interfaces/ui.ts`.
- `modules/subagents/background-protocol.ts` — background-subagent bus channels. The Module's
  `background-bridge.ts` consumes its parser, bounds strings into host view models, and exposes a
  bridge that owns instance authority, subscription lifecycle, cancellation, and the job map,
  published through `interfaces/ui.ts`.
- `modules/workflows/protocol.ts` — workflow summaries, background events, and control envelopes.
  The Module's `bridge.ts` consumes the parsers and owns control correlation, and `view-model.ts`
  resolves tool-result details against authoritative runs, both published through `interfaces/ui.ts`.
  Both bridges delegate instance authority, routed copy-on-write updates, reset/replacement gating,
  and run caps to `shared/lib/instance-scoped-runs.ts`.

The host still treats extension payloads as untrusted input: parsers validate shape and routing,
and the view models bound every string.

## Dependency injection conventions

- Dependencies are passed as an options object with production defaults. The application
  composition root resolves them explicitly; directly loaded extension wrappers construct the
  equivalent defaults. There are no module-level resource owners created as import side effects.
- Constructors are public. Tests build real objects with fake collaborators (fake
  `AgentSessionRuntime`, private `EventBus`, fake `MenuHost`, fake filesystem) instead of casting
  through private APIs.
- Narrow seams are preferred over mocks: `MenuController` is a `Pick<>` of the controller, the web
  retention takes a `WebOutputRetentionFileSystem`, file-search takes `createCapture`, the workflow
  extension accepts a whole `backend`.
- One deliberate exception: the shared child-agent runtime caches its process-wide semaphore on
  `globalThis` so a duplicated module instance still shares one concurrency limit. Subagents and
  workflow agents draw from the same slots.

## Testing strategy

- Test at module boundaries. Pure modules (protocols, reducers, formatters, key predicates) are
  tested as functions. Stateful modules are driven through their public interface with injected
  fakes (`controller.test.ts` binds a fake session and emits session events; `menus.test.ts`
  drives `createMenus` with a fake host).
- Where the real boundary is a process or the filesystem, tests use the real thing: the shared
  child-agent runtime and the subagent runner spawn a fixture child, the approval store races a
  real second process, worktree tests run real `git`, run-storage tests inject real corruption.
- Bundled-skill tests materialize the real embedded assets and load the resulting path through Pi's
  public resource loader. The compiled executable smoke test verifies that `fs.access` and reads work
  against those ordinary files.
- `bun run check` is the gate: Biome, `tsc`, the full test suite, a binary build, and a smoke test
  of the built executable (`scripts/smoke-build.ts` → `dist/pui --workflow-smoke`).

## Notes

`@earendil-works/pi-tui` remains a deliberate direct dependency because the controller reuses its
`CombinedAutocompleteProvider`; pui's visible renderer remains OpenTUI. Bundled resources augment
normal Pi discovery. Global and trusted project extensions and skills still load from Pi's regular
configuration, and the bundled extensions stay loadable in plain `pi` via `pi -e`.
