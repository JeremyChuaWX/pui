# Simplification pass 4 — plan

**Status:** Proposed.

Read `docs/ARCHITECTURE.md` first. Passes 1–3 (plans in git history: `docs/refactor-handoff.md`,
`docs/refactor-plan-pass3.md`) landed clean:
full-repo scan found no dead exports, no one-importer micro-files, `truncateUtf8` deduped,
`InstanceScopedRuns` unification real. Remaining work: host/UI knowledge duplicated across files,
truncation *composition* still 4-way copied (one copy buggy), `backend.ts` still 1087 lines, and
pass 3's deferred Phase E (shared child-agent runtime) — which also fixes three real bugs.

## Bugs found during review (fixed by the phases below)

1. Workflow drops preset timeouts: `run-job.ts:144` passes `agent.timeoutMs` (explore=120s), but
   `agent-executor.ts:39` passes the workflow's clamped default (600s). 5× the intended timeout.
2. No global cap on child Pis: subagents share one process-wide semaphore (limit 4), but each
   workflow run gets its own `AbortableSemaphore` (`backend.ts:843,945`) — N runs × 4 agents,
   unbounded in N, none consulting the subagent limit.
3. Web truncation notice lies: `web/output-retention.ts:95-134` computes the notice from the
   full-limit preview but emits a smaller re-truncated preview; the other three copies iterate to
   a fixed point precisely to avoid this.

## Phase A — mechanical (no behavior change)

- Drop re-export shims: `subagent/protocol.ts:5` (truncation fns — import `shared/retained-output`
  directly in `runner.ts`/`json-events.ts`); `src/background-subagent.ts:15` (`BACKGROUND_SUBAGENT_*`
  constants, test-only pass-through — point tests at `background-protocol.ts`).
- Dedup `recordArgs` (verbatim in `src/format.ts:84-88` + `src/tool-executions.ts:23-27`).
- Collapse 7 near-identical `createMemo` kind-narrowers in `ui/transcript.tsx:39-66`.
- `src/bundled-skills.ts:40-57`: one `map` producing `{source, target}` pairs; delete the
  impossible-index guard.
- Web comp-root nits: include `codexAuthPath` in `createDefaultWebDependencies`'s resolved bag;
  reset the Codex `search_session_*` id on `session_start` (`search.ts:296`) like the retention owner.
- Move workflow presentation (`format.ts:15-44` — status icons/labels/tones/summary; zero coupling
  to `buildDisplayItems`) → `src/ui/workflow-view.ts`, symmetric with `ui/subagent-view.ts`.

## Phase B — host/UI: one source per piece of knowledge

- **Global key table**: `app.tsx:403-563` if-chain, help text in `dialogs.tsx:252-269`, and
  list-cycling duplicated `app.tsx:454-465`/`dialogs.tsx:108-119` = three copies of the shortcut
  map. Add `globalKeyIntent(key)` table (`{name, ctrl?, intent, label, description}`) +
  `listNavigationDirection(key)` to `ui/keys.ts`; `app.tsx` becomes `switch (intent)`; Help renders
  from the table (pattern already established by `extensionConfirmKeyHint`). Gets the logic under
  `keys.test.ts` — `app.tsx` has no test file.
- **Command descriptors**: `LOCAL_COMMANDS` (`controller.ts:124-209`) and palette
  (`menus.ts:303-334`) are two drifted lists (palette-only: Tool details, Edit in nvim; slash-only:
  `/name` `/reload` `/session`). One exported descriptor list feeds both; replace the
  `app.tsx:392-400` `PromptAction` if-chain with a `Record<PromptAction, () => void>`. Fix
  `index.tsx:126` dropping the returned action (`pui "/models"` silently no-ops).
- **Pure extractions from `app.tsx`**: `extensionDialogState(request, callbacks)` → `ui/dialogs.tsx`
  (from `app.tsx:92-130`); `resolveWorkflowNavigation(pending, snapshot, now)` pure fn (from the
  30s-timer/session-guard routing at `app.tsx:139-191`). Leave prompt/completion orchestration
  (`app.tsx:206-306`) — tangled with the textarea ref by nature; extraction invents a seam.

## Phase C — one bounded-output composer

One `composeBoundedOutput(fullText, {maxBytes, maxLines?}, noticeOptions)` in
`shared/retained-output.ts` (fixed-point preview+notice budgeting) replacing the four copies:
`subagent/index.ts:106-139`, `file-search/index.ts:91-122`, `subagent/background-manager.ts:78-104`,
`web/output-retention.ts:95-134`. ~120 lines gone; fixes bug 3. Changes user-visible web tool text —
update pinned tests deliberately.

## Phase D — split `backend.ts` (prep for E)

- Trivial (zero state coupling): lines 200-337 out → `preflight.ts` (`eraseTypeOnlyNamespaces` +
  `preflightWorkflow`) and `node-resolution.ts` (`commandVersion`, `resolveWorkflowNode`,
  `runWorkflowShell`).
- The real seam inside `execute` (371 lines): process mechanics (spawn/decoder/stderr tail/
  watchdog/timeout/close, lines 444-475 + 735-790) vs RPC semantics (`handle`, 481-734) share only
  `send`/`finish`/`pending`/`active`. Extract `WorkflowWorker` class (`send`, `onFrame`,
  `terminate`, `closed`) next to `worker-protocol.ts`; RPC dispatcher → `createRpcHandler(...)`
  module. `execute` shrinks to ~40 wiring lines.
- Do NOT split the `ActiveRun` map / publish / persist / backend methods — same mutable state,
  splitting moves coupling into parameter lists.
- Result: ~1087 → ~350 (backend) + ~250 (rpc handler) + ~180 (worker) + ~140 + ~80.

## Phase E — shared child-agent runtime (TODO item 2)

Coupling today is exactly two imports (`agent-executor.ts:2-3` → subagent's `protocol`/`runner`),
but the seam is wrong: workflow builds a fake `SubagentDetailsV1` it never displays because
`runSubagent` demands one, then throws away the whole event stream (`onSnapshot` never passed) that
`WorkflowAgentSummaryV1.recentActivity` is shaped to hold (activity + usage types are byte-identical
across the two protocols).

New `extensions/shared/child-agent.ts` owning: preset lookup + `resolveModel` + `childArgs` +
`getPiInvocation`; spawn (detached, shell:false); NDJSON stdout parse + the `runner.ts:274-401`
dispatch table reduced to a neutral throttled `ChildAgentEvent` union; bounded stderr; termination
(abort/timeout/SIGTERM→SIGKILL grace — 3rd copy of this logic, `bounded-process.ts` already
generalizes it); usage aggregation + fingerprint dedupe; terminal-status classification; model-label
canonicalization; **one process-wide child-Pi concurrency slot** (fixes bug 2; per-run workflow
semaphore stays — it also gates shell RPCs).

Then: `subagent/runner.ts` = adapter folding events → `SubagentDetailsV1`;
`workflow/agent-executor.ts` = adapter folding events → `WorkflowAgentSummaryV1.recentActivity`
(feature win: live workflow-agent activity for free). Fix bug 1 (preset timeout default), collapse
the triple role allowlist (`AGENTS` keys / `agent-executor.ts:20` / `:57`) and double
`resolveModel`. Move `subagent/agents/*.md` → `shared/agents/` (kills the `shared/presets.ts:4-5`
back-reference, the last inverted edge).

NOT unified (deliberate): wire protocols (single-ownership invariant), durable replay/journal,
worktree isolation + shared-writer accounting, retries, output spill (`RetainedOutputStore` is a
model-facing contract; workflow returns bounded JSON frames), `BackgroundSubagentManager`
bookkeeping, the two NDJSON splitters' error policies (fail-closed vs degrade).

## Explicitly not doing

Bridges base class over `workflow-bridge.ts`/`background-subagent.ts` (remaining ~12-line adapters
differ where the protocols differ); `format.ts` projection/reconciliation split. Still-standing
pass-3 exclusions: no merging UI components back into `app.tsx`; no `js-scan.ts`+`source.ts` or
`session-lifecycle.ts`→`index.ts` or `manager.ts`+`worktree.ts` merges; `workflow/api.ts` stays
(package.json public export); `workflow-smoke.ts` stays compiled into the binary for
`scripts/smoke-build.ts`.

## Order + verification

A → B → C independent of D → E; D before E (agent RPC block `backend.ts:590-726` collapses onto the
shared runtime). Phase E is its own branch. Per item: `bunx tsc --noEmit` + targeted `bun test`;
`bun run check` before each commit; one commit per item, conventional messages; behavior parity
except bugs 1–3 and Phase C notice text — state divergences in commit messages. Update
`docs/ARCHITECTURE.md` at the end of each phase.

## Unresolved questions

1. Bug 2 fix semantics: workflow agents join the subagent semaphore (one global limit of 4,
   `PI_SUBAGENT_MAX_CONCURRENCY`) or a separate global child-Pi cap layered under per-run fairness?
2. Bug 1 fix: workflow `explore` agents drop from 600s → 120s timeout. Intended, or should
   workflows keep their own clamp and only default from the preset?
3. Command table: minimal in-place dedup, or full extraction to `src/commands.ts` bundled with the
   autocomplete surface (`controller.ts:534-629`)? Pass 3 folded `commands.ts` in deliberately —
   re-extraction only pays off with the completion chunk.
4. Phase E scope: populate workflow `recentActivity` from the shared event stream now (visible
   protocol/UI change) or land the runtime with parity first?
