# Extension adoption implementation plan

This document is a self-contained handoff for implementing selected ideas from Davis' [`my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup/tree/797eaf6d6f178759cf7aabde927ef15c91346e7e/extensions) in pui.

## Scope

Implement, in order:

1. Bundled model-facing `fd` and `rg` tools.
2. Stable long-form model labels in subagent cards and the sidebar/status area.
3. True background subagents, after the first two changes are complete and stable.

Explicitly out of scope:

- Do not integrate Davis' Firecrawl search extension.
- Do not change the existing pui `web_search` or `web_crawl` tools.
- Do not add Effect, the Firecrawl SDK, the Claude Agent SDK, or a Codex backend.
- Do not port `@earendil-works/pi-tui` renderers or overlays into pui's OpenTUI view.
- Do not weaken the current child isolation flags or add permission-bypassing backends.

## Repository requirements

Before editing:

1. Read `AGENTS.md` and `CONTRIBUTION.md`.
2. Read the relevant extension README and tests completely.
3. Preserve normal Pi extension discovery while adding application-owned bundled tools.
4. Keep renderer-facing details bounded, versioned where appropriate, and independent of extension-owned code.
5. Use conventional commits if commits are requested.

Validation for every implementation task:

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun scripts/smoke-build.ts
```

Prefer focused tests during development, then finish with `bun run check`.

---

# Phase 1: bundled `fd` and `rg` tools

## Goal

Add first-class, model-facing file discovery and content search tools while preserving pui's minimal dependencies and compiled Bun executable support.

## Proposed layout

```text
extensions/file-search/
  index.ts
  args.ts
  binaries.ts
  process.ts
  output.ts
  index.test.ts
  README.md

src/bundled-extensions.ts
src/controller.ts
src/bundled-extensions.test.ts
README.md
package.json
```

File names may be adjusted if a smaller layout is clearer, but keep pure argument construction separate from process execution.

## Tool APIs

### `fd`

Parameters:

- `pattern?: string` — regex matched against file names; glob when `glob` is true.
- `path?: string` — defaults to the session cwd.
- `type?: "file" | "directory" | "symlink"`.
- `extension?: string`.
- `glob?: boolean`.
- `hidden?: boolean`.
- `max_depth?: integer` — range 1–64.
- `limit?: integer` — default 1000, maximum 10000.

### `rg`

Parameters:

- `pattern: string`.
- `path?: string` — defaults to the session cwd.
- `glob?: string`.
- `file_type?: string`.
- `case_sensitive?: boolean` — omitted means smart case.
- `fixed_strings?: boolean`.
- `hidden?: boolean`.
- `context?: integer` — range 0–20.
- `limit?: integer` — default 100 matches per file, maximum 1000.

Use `StringEnum` for string enums.

## Argument safety

Port the behavior, not the Effect implementation, from Davis' file-search extension:

- Execute binaries directly with argument arrays and `shell: false`.
- Place patterns after `--` so a value such as `--help` cannot become a flag.
- Strip one accidental leading `@` from path arguments.
- Expand `~` and `~/...`.
- Strip leading dots from `fd` extensions.
- Use `--color=never`.
- Keep builders synchronous, pure, and exhaustively unit tested.

Expected defaults:

```text
fd --color=never --max-results 1000 -- ""
rg --line-number --color=never --no-heading --with-filename \
   --smart-case --max-count 100 -- <pattern>
```

## Binary resolution

Initial implementation:

1. Resolve system `fd`, then `fdfind`.
2. Resolve system `rg`.
3. If missing, return an actionable tool error explaining what to install.

Do not download binaries during application or session startup.

A later opt-in managed installer may be added only if it:

- uses a persistent platform-appropriate pui cache path, never a path relative to `import.meta.url` in the compiled executable;
- permits only HTTPS;
- pins versions and SHA-256 hashes;
- limits archive size and redirects;
- stages and renames atomically;
- handles unsupported platforms without attempting a download.

## Process and output behavior

Implement a small Node/Bun process runner following the safety patterns in `extensions/subagent/runner.ts`:

- timeout after 60 seconds;
- honor the tool `AbortSignal`;
- use a detached process group on POSIX;
- send SIGTERM, then SIGKILL after a short grace period;
- avoid leaving descendant processes behind;
- bound stderr to 64KB;
- stream stdout rather than retaining unbounded output;
- retain at most Pi's `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES` in memory;
- stream complete stdout to a private temporary file;
- delete the temporary directory if output was not truncated;
- retain the private full-output path only when truncation occurred;
- treat `rg` exit code 1 with no output as “no matches”, not an error.

Use private permissions where supported: mode `0700` directory and `0600` output file.

Tool result details should remain renderer-neutral and include:

```ts
interface FileSearchDetails {
  binarySource: "system" | "managed";
  count: number;
  truncated: boolean;
  fullOutputPath?: string;
}
```

A more specific details type per tool is acceptable. Do not import regular-Pi TUI components.

## Prompt guidance

Add concise tool snippets and guidelines that explicitly name each tool:

- Prefer `fd` for discovering files by name, extension, or glob.
- Prefer `rg` for searching file contents.
- Use `fixed_strings` for literal code containing regex metacharacters.
- Continue using `bash` for complex pipelines and post-processing.

## pui integration

- Register the extension as a named inline factory, for example `pui-file-search`.
- Preserve all normal global and trusted project extensions.
- Ensure there is exactly one registered `fd` and one registered `rg` after initial load, reload, new session, fork, and resumed session.
- Reuse the same system `fd`/`fdfind` resolution helper when constructing `CombinedAutocompleteProvider` so tool execution and `@` completion agree.
- Generic pui tool cards are sufficient for the first implementation.

## Phase 1 tests

At minimum cover:

- every argument option and default;
- `--` injection safety for patterns beginning with `-`;
- `@` stripping and home expansion;
- limit/depth/context bounds;
- `fd`/`fdfind` resolution order;
- missing binary errors;
- no-match handling;
- timeout and cancellation;
- descendant process termination on POSIX;
- bounded stderr;
- 50KB and 2000-line truncation;
- full spill-file contents and permissions;
- cleanup for untruncated output;
- bundled extension loading across reload and session replacement;
- final compiled executable smoke test.

## Phase 1 acceptance criteria

- The model can call `fd` and `rg` without shell interpolation.
- Large searches cannot flood model context or unbounded process memory.
- Cancellation leaves no child process behind.
- `@` completion keeps its current behavior.
- pui builds as a standalone native executable without adding runtime dependencies.

---

# Phase 3: stable long-form subagent model labels

## Problem

`extensions/subagent/index.ts` initializes a run with a long model specification such as:

```text
openai-codex/gpt-5.4-mini:off
```

`extensions/subagent/runner.ts` later overwrites `run.model` from `message.model` during `message_update`, `message_end`, and final settlement. Child JSON events often report only the short model id, causing cards and the sidebar/status area to switch widths and flicker.

## Required behavior

Resolve one stable display label at the protocol producer:

1. Build a canonical child label from `message.provider` and `message.model` when both are available.
2. Never replace an existing long-form label with a short model id.
3. Preserve a valid thinking suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max`) when the reported canonical model is otherwise unchanged.
4. Allow the placeholder `default` to promote to `provider/model` once the child reports both values.
5. If the child genuinely reports a different model, update to the new canonical `provider/model`, never to a short id.
6. If an event lacks a provider and supplies only a short model id, retain the current long label and wait for a better event.

Examples:

```text
openai-codex/gpt-5.4-mini:off
+ provider=openai-codex, model=gpt-5.4-mini
= openai-codex/gpt-5.4-mini:off

default
+ provider=openai-codex, model=gpt-5.4-mini
= openai-codex/gpt-5.4-mini
```

## Implementation notes

- Add a small pure helper in `extensions/subagent/runner.ts` or a nearby shared module.
- Apply it at all three overwrite points: streaming message updates, finalized messages, and terminal snapshots.
- Fix the producer rather than adding UI debounce or masking the value in `src/app.tsx`.
- This should not require a subagent protocol version change.

## Phase 3 tests

Add focused tests proving:

- an initial long label never shortens;
- a thinking suffix remains stable;
- `default` promotes to a canonical long label;
- provider-less short events do not clobber a long label;
- a genuinely changed provider/model becomes a new long label;
- the final terminal snapshot does not regress to a short label;
- display reconciliation no longer changes solely because a model id shortened.

Likely files:

```text
extensions/subagent/runner.ts
extensions/subagent/runner.test.ts
src/subagent-integration.test.ts
```

## Phase 3 acceptance criteria

- Subagent cards and sidebar/status entries consistently show long-form model labels.
- No visual width flicker occurs when child assistant events arrive.
- Generic children still reveal their actual model after the first complete provider/model event.

---

# Phase 4: true background subagents

Do not begin Phase 4 until the current blocking subagent and Phase 3 behavior have a green baseline.

## Goal

Allow the parent model to start a subagent, continue working, and later receive, inspect, await, or cancel the result. Preserve the existing blocking `subagent` tool for compatibility.

The first version remains Pi-only, process-isolated, one-shot, and non-interactive. Do not add Claude/Codex backends or takeover/steering UI.

## Recommended architecture

Use a host-created Pi `EventBusController` as the live bridge between the bundled extension and pui:

```text
PuiController
  └─ host-owned EventBusController
       ├─ passed to DefaultResourceLoader as eventBus
       ├─ receives versioned background-job snapshots
       └─ updates PuiSnapshot.backgroundSubagents

subagent_spawn / wait / check / cancel / list
  └─ BackgroundSubagentManager
       ├─ reuses runSubagent()
       ├─ shares the existing process-wide semaphore
       └─ owns one AbortController per job
```

Do not use:

- a hidden process-global manager singleton;
- long-running spawn tool calls;
- repeated model-visible custom messages for progress;
- changes to Pi's `AgentSessionEvent` union.

`createEventBus` is exported by `@earendil-works/pi-coding-agent`, and `DefaultResourceLoaderOptions` accepts an `eventBus`. Create one stable bus per `PuiController` runtime and pass it through the runtime factory across session replacement.

## Tool surface

Keep the existing blocking tool unchanged:

```text
subagent(prompt, cwd, agent?, model?)
```

Add:

### `subagent_spawn`

```ts
{
  prompt: string;
  cwd: string;
  agent?: "worker" | "explore";
  model?: string;
  name?: string;
}
```

- Returns immediately with a job id.
- Uses the same generic/worker/explore presets and isolation flags as the blocking tool.
- Derives a bounded title from the first non-empty prompt line when `name` is omitted.

### `subagent_wait`

```ts
{ ids: string[] }
```

- Waits for all requested jobs to settle.
- Aborting this tool stops waiting but does not cancel the jobs.
- Consumes automatic delivery for returned jobs.

### `subagent_check`

```ts
{ id: string }
```

- Returns current status, recent activity, and a bounded latest-output preview.
- Does not wait or consume delivery.

### `subagent_cancel`

```ts
{ ids: string[] }
```

- Cancels queued or running jobs and waits for terminal state.

### `subagent_list`

```ts
{}
```

- Lists all jobs tracked by the current extension instance.

Prompt guidance must tell the model to continue working after spawn and use wait only when progress depends on the result.

## Manager modules

Suggested layout:

```text
extensions/subagent/
  background-manager.ts
  background-protocol.ts
  result-delivery.ts
  presets.ts
  index.ts
  runner.ts
  semaphore.ts

src/
  background-subagent.ts
  controller.ts
  types.ts
  app.tsx
```

Refactor preset/model/cwd helpers out of `index.ts` only when needed by both blocking and background paths. Keep the diff focused and preserve existing public behavior.

## Job lifecycle

Statuses should remain compatible with the existing subagent vocabulary:

```text
queued → starting → running → succeeded | failed | cancelled | timed_out
```

Rules:

- `subagent_spawn` validates parameters and cwd before returning success.
- The manager starts semaphore acquisition asynchronously and returns the queued job immediately.
- Blocking and background jobs share `PI_SUBAGENT_MAX_CONCURRENCY` and FIFO semaphore fairness.
- The spawn tool's `AbortSignal` is checked during creation but must not remain linked to the background job after a successful return.
- A per-job controller handles explicit cancellation and session shutdown.
- Keep no more than 64 jobs; prune the oldest terminal jobs first.
- Preserve current 10-minute worker/generic and 120-second explore timeouts.
- Reuse `runSubagent()` for process startup, JSON parsing, progress throttling, process-tree termination, and usage aggregation.

## Live background protocol

Use a separate versioned protocol rather than weakening `pi.subagent` v1's invariant that `run.id` equals the outer blocking tool call id.

Proposed envelope:

```ts
interface BackgroundSubagentEventV1 {
  schema: "pi.subagent.background";
  version: 1;
  sessionId: string;
  instanceId: string;
  type: "ready" | "upsert" | "remove" | "reset";
  job?: {
    id: string;
    title: string;
    prompt?: string;
    run: SubagentRunV1;
  };
}
```

Protocol rules:

- Emit complete job snapshots, never deltas.
- Bound title, prompt, activity, preview, diagnostics, and paths.
- Never include raw child JSONL or an unbounded transcript.
- Use a namespaced event channel such as `pui.subagent.background`.
- `sessionId` prevents cross-session updates.
- `instanceId` rejects late updates emitted by an extension replaced during reload.
- The host validates unknown/malformed payloads without importing extension-owned parsing code.
- Unknown future versions are ignored or shown through generic persisted messages, never guessed.

## Controller ownership and session replacement

The host event bus should be created in the `PuiController.create` path and captured by the runtime factory so newly created `DefaultResourceLoader` instances receive the same bus.

The controller should:

- subscribe once to the background channel;
- keep a map keyed by job id;
- accept only the current session and extension instance;
- clear background state while binding a replacement session;
- refresh at a coalesced cadence rather than once per token;
- unsubscribe and clear the bus during final controller disposal.

The extension should:

- emit `ready` from `session_start` with a new instance id;
- set a shutdown flag before aborting jobs;
- abort all queued and running jobs in `session_shutdown`;
- await all job settlement concurrently with bounded teardown;
- clear deferred delivery;
- emit `reset` before the old instance becomes stale;
- never call `pi.sendMessage` after shutdown begins.

Reload, new session, resume, fork, and quit all terminate current background jobs. Initial Phase 4 does not reattach jobs or restore manager state.

## Deferred result delivery

Port the idea from Davis' setup using a small pending-result map and wait-interest reference counts.

Settlement behavior:

1. If an active `subagent_wait` is interested in the job, mark it consumed and do not queue automatic delivery.
2. Otherwise place an immutable terminal result copy in the deferred map.
3. If the parent is idle, flush immediately.
4. If the parent is working, flush on `agent_settled`.
5. A later wait can consume a deferred result before the flush.
6. Flush each result at most once.

Automatic delivery:

```ts
pi.sendMessage(
  {
    customType: "subagent-result",
    content: "...bounded result...",
    display: true,
    details: { id, title, status }
  },
  { deliverAs: "followUp", triggerTurn: true }
)
```

Output budgets:

- preserve Pi's 50KB/2000-line hard ceiling;
- use a smaller per-result budget for automatic delivery;
- apply a total and per-job budget to multi-job waits;
- include the existing private full-output path when available.

Only delivered custom result messages persist in the first implementation. Active manager state is intentionally in-memory and session-scoped.

## OpenTUI integration

Extend the host snapshot independently of ordinary tool execution:

```ts
interface PuiSnapshot {
  // existing fields
  backgroundSubagents: BackgroundSubagentViewModel[];
}
```

Initial UI requirements:

- Include active background jobs in the existing Subagents sidebar/status section.
- Use stable long-form model labels from Phase 3.
- Show title, status, elapsed time, active child tool, and compact usage.
- Add a pui-native `/subagents` picker for active and recently settled jobs.
- Permit explicit cancellation from the picker.
- Keep the original `subagent_spawn` tool card generic or associate it with the job id; do not block Phase 4 on transcript placement work.
- Render persisted `subagent-result` custom messages clearly.

Not required initially:

- takeover UI;
- steering or follow-up input into a child;
- child transcript browsing;
- reattaching after reload or session switch;
- alternate harnesses.

## Phase 4 tests

Manager and extension:

- spawn returns before runner completion;
- four jobs run and later jobs remain visibly queued;
- blocking and background jobs share the same limit;
- queued cancellation never starts a child;
- running cancellation kills descendants;
- an aborted wait leaves jobs running;
- wait interest prevents duplicate automatic delivery;
- deferred results flush exactly once on `agent_settled`;
- idle completion delivers immediately;
- session shutdown aborts all jobs and sends no stale results;
- oldest terminal jobs are pruned above the tracking limit;
- output budgets and full-output paths remain correct.

Protocol and host:

- valid ready/upsert/remove/reset events reduce correctly;
- malformed payloads and unknown versions are rejected;
- stale session ids are ignored;
- stale extension instance ids are ignored;
- rapid snapshots are coalesced without losing terminal state;
- session replacement clears active jobs;
- current blocking subagent cards remain unchanged;
- persisted `subagent-result` messages survive resume.

Build and integration:

- bundled tools exist exactly once across reload/replacement;
- normal extension discovery still works;
- existing subagent test suite remains green;
- the native executable builds and smoke-tests.

## Phase 4 acceptance criteria

- A model can spawn background work and continue without waiting.
- Background jobs are visible and individually cancellable.
- Results are delivered exactly once unless explicitly consumed by wait.
- Reload/session replacement cannot leak child processes or stale UI updates.
- The existing blocking `subagent` tool and old persisted sessions remain compatible.
- No additional agent harness or permission bypass is introduced.

---

# Suggested delegation order

These tasks can be assigned to separate subagents only where dependencies allow.

## Task A: file-search argument and binary layer

Independent work:

- `extensions/file-search/args.ts`
- `extensions/file-search/binaries.ts`
- pure tests

Do not edit controller or UI files.

## Task B: file-search process/output layer

Depends only on the agreed details types and argument arrays:

- process spawning and termination
- streaming capture
- truncation and spill files
- process-focused tests

Coordinate with Task A on exported types only.

## Task C: file-search registration and host integration

Start after Tasks A and B stabilize:

- register tools
- bundle factory
- autocomplete reuse
- docs and integration tests

## Task D: model-label stabilization

Independent of file-search and safe to run in parallel:

- fix `runner.ts`
- add focused runner and host integration tests

Avoid unrelated protocol or UI changes.

## Task E: Phase 4 manager core

Start only after Task D and the current subagent suite are green:

- refactor shared presets carefully
- background manager
- tool registration
- deferred delivery
- manager tests

Do not edit OpenTUI files yet.

## Task F: Phase 4 host event bridge

Can begin once the background protocol is fixed:

- host-created event bus
- defensive protocol parser/reducer
- controller snapshot integration
- stale instance/session tests

## Task G: Phase 4 OpenTUI presentation

Start after Tasks E and F expose stable view models:

- sidebar/status integration
- `/subagents` picker
- cancellation action
- persisted result rendering

Do not add takeover or steering in this task.

## Final integration/review task

A separate reviewer should verify:

- process and output bounds;
- session shutdown and replacement races;
- event-bus stale-instance rejection;
- exact-once result delivery;
- tool prompt clarity and tool-name conflicts;
- no Firecrawl or extra SDK dependencies were introduced;
- full `bun run check` succeeds.
