# Simplification pass 3 — consolidation plan

Read `docs/ARCHITECTURE.md` and `docs/refactor-handoff.md` first. Passes 1–2 trended toward
extraction (deep modules, DI seams); this pass trends toward consolidation.

## Review verdict

The codebase is not bloated in lines — it's fragmented. 120 TS files / 23k lines, but 47 files /
9.9k lines (43%) are tests. Source is ~73 files / ~13k lines. The "too many files" feeling comes
from: (1) many one-importer files under 100 lines extracted in prior passes, (2) parallel test
files per micro-module, (3) real duplication between the subagent and workflow stacks — including
two copies of the same host-side reducer and two contradictory trust policies
(`src/background-subagent.ts` hand-rolls wire parsing "without trusting extension code" while
`src/workflow-bridge.ts` imports the extension's parsers directly).

Net effect of this plan: ~120 → ~95 files, a few hundred duplicated lines gone, one trust policy
instead of two, zero behavior change.

## Phase A — deletions + file merges (~15 fewer files, mechanical)

- Delete: `extensions/web/test-utils.ts` (1-line alias shim); dead exports `SubagentActivity`
  (`src/subagent.ts:14`), `Menus` (`src/ui/menus.ts:338`), `BUNDLED_SUBAGENT_SOURCE_PATH`
  (test-only). Un-export `formatToolArguments` / `resolveWorkflowRun` in `src/format.ts` if
  willing to test through `buildDisplayItems`.
- Collapse the two identical ambient `assets.d.ts` (subagent + workflow) → one
  `extensions/assets.d.ts` declaring `*.txt` and `*.md`.
- `src/` merges:
  - `focus-trap.ts` + `selection-copy.ts` + `external-editor.ts` + `prompt-history.ts` (all
    ≤51 lines, only `app.tsx` imports them) → one `src/app-support.ts` + one test file. Keeps
    every assertion; removes 6 files.
  - `toasts.ts` + `extension-dialogs.ts` (same `constructor(onChange)` shape, both
    controller-only, neither independently tested) → `src/controller-queues.ts`.
  - `commands.ts` → into `controller.ts` (also breaks their value/type import cycle).
  - Optional: `ui/workflow-page.tsx` → `ui/transcript.tsx` (same formatter imports).
- `extensions/workflow` merges:
  - `worker-source.ts` (12) → `worker-protocol.ts` (both are the worker-transport boundary; do
    NOT fold back into `backend.ts`).
  - `background-protocol.ts` (141) → `protocol.ts` (275) (already imports it, duplicates
    `record()`; both pure declarative validation). Merge their tests too.
  - `safe-directory.ts` (50) → `durable-fs.ts` (262) (same fs-safety layer, overlapping
    consumers, no own test).

## Phase B — kill duplication (the real complexity win)

- `extensions/shared/validate.ts`: one `record`/`isRecord` (currently 5 copies: workflow
  protocol ×2, subagent protocol, subagent runner, `src/background-subagent.ts`), one
  `errorMessage` (1 export + 1 private copy + ~11 inline ternaries), one bounded-string helper
  (the two `bounded()` copies diverge on `max === 0` — latent bug).
- Pick ONE trust policy for host↔extension parsing. Recommended: workflow's — import extension
  parsers, bound strings in view models. Then delete the ~40 hand-rolled guard lines in
  `src/background-subagent.ts` and move the subagent event parser into
  `subagent/background-protocol.ts` (which today parses only the control message).
- One generic instance-authority reducer (`InstanceScopedRuns<T>`) replacing the near-identical
  reducers in `src/background-subagent.ts:72-89` and `src/workflow-bridge.ts:29-57` (gate on
  sessionId, ready establishes/replaces instanceId, reset clears, capped copy-on-write upsert).
  Give subagents a bridge class like `WorkflowBridge` — removes ~25 lines of ad-hoc
  subscription/teardown in `src/controller.ts:154-172,249,742-745`.
- `extensions/shared/background-channel.ts`: one host-side channel helper replacing the ~40-line
  duplicated ready/subscribe/route-guard/shutdown wiring in `subagent/index.ts:111-166` and
  `workflow/index.ts:88-211` (drift already exists: workflow validates `cwd` in the route,
  subagent doesn't).
- Move `subagent/semaphore.ts` → `extensions/shared/` (zero subagent-specific content; workflow
  imports it — the only inverted dependency edge left). Consider `presets.ts` too.

## Phase C — test consolidation (~10 fewer files, no assertions lost)

- src:
  - `subagent-integration.test.ts` (287) → `format.test.ts` (416): never touches the controller,
    same subjects (`buildDisplayItems` + `reduceToolExecutions`), near-identical fixtures,
    directly overlapping cases.
  - `controller-workflow.test.ts` (299) → `controller.test.ts` (370): same fake-runtime harness,
    same seam. The extension-dialog tests inside it are the only coverage of that module.
  - After the reducer unification: `workflow-bridge.test.ts` + `background-subagent.test.ts` →
    one file. Only after, not before.
- workflow:
  - `budgets.test.ts` (118) → `backend.test.ts` (same constructor/subject; caps already
    partially re-tested there).
  - `recovery.test.ts` + `terminal-delivery.test.ts` + `manager.test.ts` (171+181+299) → one
    `delivery.test.ts` (three views of one machine: backend + storage + durable claim/replay;
    identical preambles).
  - Keep `transport-security.test.ts` separate (real hostile subprocesses, slow harness).
- web: test retention once at `tool-shell.ts` (`executeWebTool` single-sources it) instead of
  per-tool in `index.test.ts` — ~120 lines recoverable.
- Handoff's pending test items: shared fake `ExtensionAPI` in `extensions/test-support/`, trim
  `subagent/index.test.ts` to registration + wiring, move the sdk-integration packaging smoke
  test next to `src/bundled-extensions.test.ts`.
- ADD direct tests for `extensions/shared/` (`bounded-process.ts` 157 lines / 4 importers,
  `retained-output.ts` 173 / 3): highest fan-in, weakest direct coverage. The one place needing
  more files, not fewer.
- Keep isolated: `src/controller-background-lifecycle.test.ts` (real processes, platform-gated).

## Phase D — finish the pass-2 handoff worklist

Already documented in `docs/refactor-handoff.md`: retention-notice convergence, `truncateUtf8`
dedup, file-search retention quota, `runner.processEvent` dispatch table, `copyJob`
re-truncation, `crawl.ts` metadata bound, real composition root in `bundled-extensions.ts`.

## Phase E — optional/bigger: shared agent runtime

TODO item 2 and the (deleted) `docs/shared-agent-execution-plan.md`: one process-wide FIFO
semaphore for blocking/background subagents + workflow agents; workflow stops importing subagent
internals. Phase B's semaphore/presets move is the first step; the rest is a separate effort,
likely its own branch.

## Explicitly not doing

Would recreate problems just fixed: merging UI components into `app.tsx`; `js-scan.ts` +
`source.ts` (extraction was empirically verified); `session-lifecycle.ts` back into `index.ts`;
`manager.ts` + `worktree.ts` (unrelated concerns); unifying the two NDJSON splitters
(`json-events.ts` vs `worker-protocol.ts` — deliberately different error policies);
`workflow/api.ts` (package.json public export); `workflow-smoke.ts` (must stay compiled into
the binary for `scripts/smoke-build.ts`).

## Verification

Same as pass 2: `bunx tsc --noEmit` + targeted `bun test <dir>` while iterating;
`bun run check` before each commit (Node ≥ 22.19 on PATH); one commit per item, conventional
messages; behavior parity everywhere, state deliberate divergences in the commit message.

## Unresolved questions

1. Trust policy: OK to have `src/` import extension parsers everywhere (workflow's current
   policy), or apply the stricter no-import policy to workflow instead?
2. Test-count vs isolation: OK merging the 3 workflow delivery-machine test files into one
   ~650-line file?
3. Phase E in scope for this branch, or separate branch after this PR lands?
4. Commit the two already-deleted planning docs sitting in the working tree
   (`docs/adr/0001-*.md`, `docs/shared-agent-execution-plan.md`)?
5. Normalize import specifiers (`./x.ts` vs `./x.js`, currently 31/112 split) in this pass?
