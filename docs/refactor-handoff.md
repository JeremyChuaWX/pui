# Simplification pass 2 — handoff

Status of the completed first pass and a worklist for the next session. Read
`docs/ARCHITECTURE.md` first; every item below should land in that shape (deep modules, options-bag
DI with production defaults, protocols single-sourced, tests at module boundaries).

## Where things stand

- Branch `refactor/simplify-modules`, two commits on top of `origin/main` (`01c33a8`). Not pushed,
  no PR yet.
- `bun run check` fully green at handoff: Biome, tsc, 367 tests / 46 files, build, compiled-binary
  smoke test.
- Pass 1 delivered: protocol dedup (`src/` no longer mirrors extension wire formats), the
  `src → extensions → src` cycle broken (`extensions/workflow/agent-executor.ts`), controller DI +
  collaborators (`workflow-bridge.ts`, `extension-dialogs.ts`, `toasts.ts`, `commands.ts`),
  `app.tsx` split into `src/ui/*`, `extensions/workflow/js-scan.ts` (one tokenizer, was 3),
  `extensions/subagent/run-job.ts` (one run pipeline, was 2), web `SessionOutputRetention` deleted,
  file-search `output.ts` merged into `process.ts`, dead exports removed, private-constructor test
  casts removed.

## Worklist (rough priority order)

### 1. Split `extensions/workflow/backend.ts` (~1,380 lines, the last god file)

Concerns still mixed: type surface, external-Node discovery, default shell executor, JSON-schema
subset validation, worker bootstrap sources (two giant string literals near the top of the run
section), run lifecycle + NDJSON transport, and the public API object. Extraction plan from the
audit, still valid:

- `worker-protocol.ts` — frame validation out of the nested `handle()` (the ready/heartbeat/
  terminal/rpc envelope checks at the top of it). Payoff: `transport-security.test.ts` becomes a
  pure `parseWorkerFrame` unit test instead of ~12 real-process spawns, and the
  `testOnlyWorkerSource` production option can be deleted.
- `rpc-operations.ts` — one `runDurableOperation({ operationId, execute, journal, ... })` owning
  replay-check → pause-wait → semaphore → timeout race → result validation → journal → publish.
  The `shell` (~120 lines) and `agent` (~215 lines) branches inside `handle()` are structurally
  parallel; each becomes a request validator + one call. Payoff: `recovery.test.ts` stops needing
  the `afterDurableCompletion` production hook — delete it too.
- Pure extractions: shell/agent option validators, launch normalization (metadata check + limit
  clamping), the JSON-schema subset.
- Move `BOOTSTRAP_SOURCE`/`WORKER_SOURCE` into real files imported `with { type: "text" }` (the
  repo already does this for `writing-workflows.md` in `index.ts`).
- Introduce an injected `Platform` (`now`, `uuid`, `spawn`, `hostname`, `pid`, `isProcessAlive`,
  `log`) with production defaults. This retires `console.error` calls (manager.test currently spies
  on console to observe a failure path) and lets the timing knobs (`readyTimeoutMs`, `watchdogMs`,
  `runTimeoutMs`, `shutdownGraceMs`) leave the public options.
- Type `WorkflowBackendOptions.storage` as an interface, not the `WorkflowRunStorage` class —
  `terminal-delivery.test.ts` (renamed from `controls.test.ts`) subclasses the real class with a
  promise barrier today; an interface makes that a plain fake.
- Break the remaining type cycle: `run-storage.ts` imports `type WorkflowEntrypoint` from
  `backend.ts` while `backend.ts` imports `type WorkflowRunStorage`. Move `WorkflowEntrypoint`
  ("script" | "function") into `protocol.ts`, and rename `source.ts`'s unrelated
  `WorkflowEntrypoint` interface to `EntrypointDeclaration`.

Method note: for the js-scan extraction we verified equivalence empirically (run old and new
implementations over every repo file and diff outputs). Do the same for preflight when touching it.

### 2. `durable-fs.ts` — dedupe the cross-process lock protocol

`approval.ts` (`acquireLock`) and `run-storage.ts` (`acquireDeliveryRecoveryLock`) implement the
same mkdir-candidate → owner.json → rename → stale-detection algorithm (~80 lines each), plus
byte-identical `isProcessAlive`, `syncDirectory`, and atomic temp-write-fsync-rename helpers.
Extract `atomicWrite`, `syncDirectory`, `boundedJson` (backend has a 256 KiB copy, run-storage a
16 MiB copy), `acquireDirectoryLock({ staleMs, retries })`. Also make `approval.ts`'s module-global
`approvalWrites` map an instance field. Expected: `approval.ts` 246 → ~80 lines, `run-storage.ts`
806 → ~550. This is security-sensitive locking code — keep the two callers' stale windows and retry
policies exactly as they are (60 s/unbounded vs 30 s/3 attempts).

### 3. `bounded-process.ts` — one spawn/timeout/process-group-kill helper

The `SIGTERM → SIGKILL on -pid, else child.kill` idiom exists in `backend.ts` (`commandVersion`,
`runWorkflowShell`, `terminate` inside execute), `worktree.ts`, `extensions/subagent/runner.ts`,
and `extensions/file-search/process.ts`. Extract one
`runBoundedProcess({ command, args, cwd, env, timeoutMs, signal, maxOutputBytes })` (natural home:
a small shared module; note runner.ts has extra JSONL-streaming needs, so it may only adopt the
kill/timeout part). This is also the natural injection seam for backend worker spawning.

### 4. Shared retained-output module

Temp-file spill (mkdtemp 0700 → write 0600 → cleanup) exists 4×: `web/output-retention.ts` (the
richest — quotas + retry; keep as the base), `subagent/output-store.ts`, inside
`file-search/process.ts`, and a variant in `workflow/backend.ts`. Also: several inconsistent
"[Output truncated …]" notice strings and three `truncateUtf8` copies (`web/output-retention.ts`
private, `subagent/protocol.ts` exported, upstream `truncateHead`/`truncateTail`). Consolidate into
one shared module (e.g. `extensions/shared/retained-output.ts`) with one notice format. While
there: file-search has no retention quota (cleanup closures accumulate unbounded per session) —
give it the same policy as web. Check first whether upstream `pi-coding-agent`'s `OutputAccumulator`
could replace all of it (it isn't exported from the package index today — worth asking upstream).

### 5. Workflow extension odds and ends

- `SessionLifecycle` extraction in `extensions/workflow/index.ts`: seven mutable closure variables
  and a `lifecycleGeneration` guard compared 13×. Make it a small class.
- Verify-then-delete vestigial protocol branches: the `"remove"` background event is never emitted
  by `index.ts` (parsers/reducer branches exist in `background-protocol.ts` and
  `src/workflow-bridge.ts`); run status `"awaiting_approval"` is never produced (approval happens
  before a run exists) yet is validated/rendered; phase status `"skipped"` is never set but has
  three render special-cases; `WorkflowAgentSummaryV1.output` is validated but never written.
  Grep before each cut. Counter-example from pass 1: `"timed_out"` in
  `src/headless-workflow.ts`'s terminal set looks vestigial but is intentional defense for injected
  backends and is pinned by a test — leave it.
- Move test-only files out of the production tree: `workflow-fixture.ts`,
  `approval-process-helper.ts` (spawned by approval.test.ts — needs a path the test can still
  resolve).
- Five inline copies of `error instanceof Error ? error.message : String(error)` in this extension
  alone; `backend.ts` exports `errorMessage` — use it or share one helper.

### 6. Test hygiene

- Eight copy-pasted `waitFor`/`waitUntil` polling helpers across workflow/src tests (plus
  `web/test-utils.ts`'s `waitUntil`). One `extensions/test-support/` module; also home for one
  typed fake `ExtensionAPI` replacing the three hand-rolled `pi: any` fakes
  (`web/index.test.ts`, `file-search/index.test.ts`, `subagent/index.test.ts`,
  `workflow/index.test.ts`).
- `subagent/index.test.ts` (~630 lines) re-tests deferral/cancellation/semaphore scenarios already
  covered by `background-manager.test.ts` — now that `run-job.ts` exists, trim index tests to
  tool-registration + lifecycle wiring and test the pipeline directly.
- `subagent/sdk-integration.test.ts`: keep only the resume-persistence case; its packaging smoke
  test (~lines 40-59) belongs with `src/bundled-extensions.test.ts`.
- `backend.test.ts` wraps its factory with `allowUnsafeSharedCheckout: true` for every test, so the
  safe path is under-tested; the pure `preflightWorkflow` tests mixed into it need no process.

### 7. Smaller items noticed but not done

- `subagent/runner.ts`: `processEvent` is a ~140-line if-chain (dispatch table + one `phaseFor()`
  helper); `emit`/`deliver`/`notifySnapshot` is a three-level chain that can be one throttled
  emitter; `background-manager.ts` re-resolves `(this.options.x ?? default)` per call instead of
  normalizing deps once.
- `background-manager.copyJob` re-truncates every field on every emit for an in-process trust
  boundary that doesn't exist; producer-side transitions already cap sizes.
- `web/crawl.ts` writes the unbounded Firecrawl `metadata` object into persisted tool details with
  no reader — bound it or drop it.
- `src/bundled-extensions.ts` could become a real composition root (pass each extension its
  resolved deps, delete the `?? default` fallbacks so the shipped wiring is the tested wiring).

## Verification workflow

Per item: `bunx tsc --noEmit` + targeted `bun test <dir>` while iterating; `bun run check` before
each commit (needs Node ≥ 22.19 on PATH for backend tests; ~1 min). Keep commits per-item with
conventional-commit messages. Behavior parity is the bar everywhere except where an item explicitly
says a divergence is being resolved — state any such change in the commit message.
