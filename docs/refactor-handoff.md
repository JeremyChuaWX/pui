# Simplification pass 2 — handoff

Status after the second session. Read `docs/ARCHITECTURE.md` first; every item below should land in
that shape (deep modules, options-bag DI with production defaults, protocols single-sourced, tests
at module boundaries).

## Where things stand

- Branch `refactor/simplify-modules` on top of `origin/main` (`01c33a8`). Not pushed, no PR yet.
- `bun run check` fully green at handoff: Biome, tsc, 375 tests / 47 files, build, compiled-binary
  smoke test.
- Pass 1 delivered: protocol dedup, the `src → extensions → src` cycle broken, controller DI +
  collaborators, `app.tsx` split into `src/ui/*`, `js-scan.ts`, `subagent/run-job.ts`, dead code
  removed.
- Pass 2 (this session) delivered items 1, 2, 3, and 5 of the original worklist:
  - `backend.ts` split (1,396 → ~1,000 lines): `worker-protocol.ts` (frame validation + NDJSON
    decoder, unit-tested; transport-security.test.ts keeps only real-process supervision tests),
    `rpc-operations.ts` (validators + `runDurableOperation`; `afterDurableCompletion` hook
    deleted — recovery.test.ts blocks inside an injected storage subclass instead),
    `worker-source.ts` + `worker/*.js.txt` (byte-identical extraction of the worker/bootstrap
    string literals), `WorkflowPlatform` injection (timing knobs, uuid, log, workerSource off the
    public options; no more console spies), `WorkflowRunStore` interface for storage,
    `WorkflowEntrypoint` moved to `protocol.ts` (type cycle broken).
  - `durable-fs.ts`: shared `atomicWrite`/`exclusiveWrite`/`readBoundedJson`/`syncDirectory`/
    `isProcessAlive` and one `acquireDirectoryLock` with per-caller policies (approval:
    60 s stale/blocking 30 s deadline/conservative steal; recovery: 30 s/3 attempts/aggressive
    steal + owner-startedAt + parent fsync). approval.ts 246 → 103, run-storage.ts 806 → 652.
    Deliberate divergence: the recovery lock's owner file is now flat `owner.json` (was nested
    `owner-<token>/`).
  - `extensions/shared/bounded-process.ts`: `runBoundedProcess` + `killProcessTree`. Ported:
    worktree git commands, backend version probe, `runWorkflowShell`, worker terminate;
    file-search/runner adopted `killProcessTree` only (their streaming pipelines stay).
  - Workflow odds and ends (item 5): `SessionLifecycle` class replaces the seven index.ts closure
    variables; vestigial protocol branches deleted after grep-verification ("remove" background
    event, `awaiting_approval` run status, `skipped` phase status, `WorkflowAgentSummaryV1.output`);
    `errorMessage` shared from protocol.ts; `workflow-fixture.ts` and `approval-process-helper.ts`
    moved to `extensions/workflow/test-support/`.

## Remaining worklist (rough priority order)

### 1. Shared retained-output module (was item 4)

Temp-file spill (mkdtemp 0700 → write 0600 → cleanup) exists 4×: `web/output-retention.ts` (the
richest — quotas + retry; keep as the base), `subagent/output-store.ts`, `FileSearchOutput` inside
`file-search/process.ts`, and a variant in `workflow/backend.ts`. Also: several inconsistent
"[Output truncated …]" notice strings and three `truncateUtf8` copies (`web/output-retention.ts`
private, `subagent/protocol.ts` exported, upstream `truncateHead`/`truncateTail`). Consolidate into
one shared module (natural home now: `extensions/shared/retained-output.ts`) with one notice
format. While there: file-search has no retention quota (cleanup closures accumulate unbounded per
session) — give it the same policy as web. Check first whether upstream `pi-coding-agent`'s
`OutputAccumulator` could replace all of it (it isn't exported from the package index today — worth
asking upstream).

### 2. Test hygiene (was item 6)

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
  `worker-protocol.test.ts` and pure `rpc-operations` validators could absorb more of it.

### 3. Smaller items noticed but not done (was item 7)

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
- runner.ts and file-search/process.ts could adopt `runBoundedProcess` more fully if their
  streaming needs are folded in as hooks (deferred deliberately — their pipelines are tested and
  richer than the shared module).

## Verification workflow

Per item: `bunx tsc --noEmit` + targeted `bun test <dir>` while iterating; `bun run check` before
each commit (needs Node ≥ 22.19 on PATH for backend tests; ~1 min). Keep commits per-item with
conventional-commit messages. Behavior parity is the bar everywhere except where an item explicitly
says a divergence is being resolved — state any such change in the commit message.

Method note: for the js-scan extraction pass 1 verified equivalence empirically (run old and new
implementations over every repo file and diff outputs). Do the same for preflight if touching it.
