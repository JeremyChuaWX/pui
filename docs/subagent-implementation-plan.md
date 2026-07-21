# Extension-backed subagents: execution plan

Status: in progress — SA-01, SA-02, and SA-04 through SA-06 are implemented and verified; SA-03 and SA-07 await a regular-Pi live smoke test; SA-08 remains deferred

Last reviewed: 2026-07-21

## 1. Purpose

Implement first-class subagent operation and presentation without pretending that subagents are built into Pi core.

The capability remains a Pi extension:

- The **subagent extension** defines presets, launches child Pi processes, enforces limits, handles cancellation, and publishes renderer-neutral progress.
- **Pi core** remains unchanged and transports normal `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events.
- **pi-tui** tracks those events, recognizes the versioned subagent payload, and renders live and persisted subagent state.

Canonical repositories and paths:

- Extension repository: `/Users/jer/.dotfiles`
- Extension source: `/Users/jer/.dotfiles/stowables/pi/.pi/agent/extensions/subagent/`
- Host repository: `/Users/jer/dev/pi-tui`
- Host source: `/Users/jer/dev/pi-tui/src/`

### 1.1 Implementation review

The extension and host tracks are substantially implemented in their working trees. "Implemented" below describes the reviewed working trees, not merged history: all extension changes remain uncommitted, and the host implementation plus this plan are also uncommitted.

| Task | Review status | Evidence and remaining work |
| --- | --- | --- |
| SA-01 | Implemented and verified | `protocol.ts` and `protocol.test.ts` define and test protocol v1, state transitions, bounded activity, usage aggregation, UTF-8 truncation, and the type guard. `tsconfig.json` excludes Bun test files from the extension typecheck. |
| SA-02 | Implemented and verified | `json-events.ts`, `runner.ts`, focused tests, and deterministic fixtures cover fragmented JSONL, malformed output, concurrent child tools, bounded data, usage, abort, timeout, process-group termination, spawn failure, and invocation resolution. |
| SA-03 | Implemented; manual acceptance pending | `index.ts`, `semaphore.ts`, and tests cover the public schema, lifecycle snapshots, child isolation flags, four-child queue, queued cancellation, output truncation, failure-detail persistence, and shutdown cleanup. The required regular-Pi smoke test has not been recorded. |
| SA-04 | Implemented and verified | `src/tool-executions.ts`, reducer tests, and controller-path tests cover partial updates, out-of-order siblings, pending-call reconciliation, terminal retention through persistence, working-message derivation, session settlement, abort, replacement, and disposal cleanup. |
| SA-05 | Implemented and verified | `src/subagent.ts`, formatter changes, and tests defensively parse protocol v1, adapt legacy details, retain opaque partial/final details, derive running state from executions, restore persisted cards, and fall back for malformed or unknown versions. |
| SA-06 | Implemented and verified | `app.tsx` has status-specific collapsed and expanded subagent cards, delegated context/activity/usage/output presentation, a separate active-subagent sidebar group, generic fallback, and an active-only one-second elapsed timer. Deterministic protocol fixtures were manually checked at 80x28 and 140x36, with the expanded view at 140x50. |
| SA-07 | Automated host work implemented; regular-Pi acceptance pending | Extension fixtures and SDK persistence/resume coverage pass. Host reducer-to-controller-to-formatter tests cover lifecycle updates, failures, cancellation, timeout, malformed details, five queued siblings, out-of-order completion, resume, extension absence, and generic tools. Both READMEs document the ownership boundary, and narrow/wide fixture checks pass. The regular-Pi live smoke test remains. |
| SA-08 | Deferred | No trusted preset discovery has been added, as intended. |

Verification run during this review:

```text
/Users/jer/.dotfiles/stowables/pi/.pi/agent
  bun test extensions/subagent  -> 32 pass, 0 fail
  npm run typecheck             -> pass

/Users/jer/dev/pi-tui
  npm run check                 -> 28 pass, 0 fail
```

The review found no blocking Pi core defect and no reason to change the dependency map. Remaining first-release work is SA-03/SA-07's regular-Pi live smoke test; the pi-tui live-model command remains optional.

## 2. Required outcome

When the parent agent calls `subagent`, pi-tui must show:

- queued, starting, running, succeeded, failed, cancelled, and timed-out states;
- agent preset, model, working directory, and elapsed time;
- active child tools and a bounded recent-activity list;
- turns, token/cache usage, and cost;
- final Markdown output or an actionable diagnostic;
- independent state for multiple concurrently running subagent tool calls;
- the same completed summary after a session is resumed.

The regular Pi TUI, JSON mode, RPC consumers, and hosts that do not understand the protocol must continue to receive a valid ordinary tool result.

## 3. Scope decisions

### 3.1 One subagent per outer tool call

Keep the current tool shape:

```ts
{
  agent: "explore",
  prompt: "Focused delegated task",
  cwd: "/absolute/or/relative/path",
  model?: "provider/model:thinking"
}
```

Do not add batch or chain parameters in the first release. Pi already executes sibling tool calls concurrently. Separate outer calls provide better identity, cancellation boundaries, result isolation, and UI presentation.

### 3.2 No Pi core fork

The first release must use the existing `AgentToolUpdateCallback` and `tool_execution_update.partialResult` APIs. Changes to `@earendil-works/pi-agent-core` or `@earendil-works/pi-coding-agent` are out of scope unless implementation proves a blocking defect.

### 3.3 Renderer-neutral contract

The extension's `details` object is the integration contract. pi-tui must not depend on the extension's `@earendil-works/pi-tui` `renderCall` or `renderResult` components and must not identify runs only by `toolName === "subagent"`.

### 3.4 Preserve the current security boundary

The initial `explore` preset remains read-only and child Pi continues to run with extensions, skills, prompt templates, context files, and sessions disabled. Write-capable and project-local presets are a later, separately reviewed task.

## 4. Protocol contract

Task `SA-01` owns the canonical TypeScript definition in the extension. pi-tui owns a defensive parser rather than importing across repositories.

```ts
interface SubagentDetailsV1 {
  schema: "pi.subagent";
  version: 1;
  run: {
    id: string; // outer Pi toolCallId
    agent: string;
    model: string;
    cwd: string;
    status:
      | "queued"
      | "starting"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "timed_out";
    phase?: "queued" | "spawning" | "thinking" | "tool" | "exiting";
    startedAt?: number;
    updatedAt: number;
    endedAt?: number;
    activeTools: Array<{
      id: string;
      name: string;
      title: string;
      startedAt: number;
    }>;
    recentActivity: Array<{
      sequence: number;
      timestamp: number;
      kind: "turn" | "tool_start" | "tool_end" | "assistant" | "diagnostic";
      title: string;
      isError?: boolean;
    }>;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: number;
      turns: number;
    };
    outputPreview?: string;
    error?: string;
    fullOutputPath?: string;
  };
}
```

Protocol invariants:

1. `run.id` is the outer tool call ID passed to `execute()`.
2. Every `onUpdate()` contains a complete current snapshot, not an event delta.
3. `recentActivity` is ordered, has monotonically increasing `sequence`, and is capped at 20 entries.
4. `activeTools` contains only child tools that have started but not ended.
5. Partial updates are UI-only. Final model-visible output remains in the outer result's `content`.
6. Final `details` uses the same protocol and a terminal status.
7. Raw child transcripts and unbounded stdout/stderr are not stored in details.
8. Unknown protocol versions must fall back to generic tool rendering.
9. pi-tui should recognize the extension's existing legacy shape (`agent`, `model`, `toolCalls`, `usage`) for old sessions.

## 5. Agent execution rules

Each implementation agent must:

1. Take exactly one task packet below unless explicitly assigned a group.
2. Verify that dependency tasks are complete before editing.
3. Read the current files and installed Pi API types before relying on this plan; generated APIs may have changed.
4. Keep changes within the repository named by the task.
5. Add or update tests in the same task as behavior changes.
6. Run the task's verification commands.
7. Do not modify Pi core packages under `node_modules`.
8. Do not add dependencies without approval.
9. Do not commit, push, or mark later tasks complete.
10. Return files changed, acceptance results, verification output, blockers, and follow-ups.

The orchestrator should run cross-repository integration checks after `SA-07` and update plan status. Implementation agents should not leave stale running child processes or generated output in either repository.

---

## 6. Task packets

### SA-01 — Define the extension protocol and pure state helpers

Status: implemented and verified in the uncommitted extension working tree

Repository: `/Users/jer/.dotfiles`

Depends on: none

Files:

- Add `stowables/pi/.pi/agent/extensions/subagent/protocol.ts`
- Add `stowables/pi/.pi/agent/extensions/subagent/protocol.test.ts`
- Update `stowables/pi/.pi/agent/package.json` only if a test script is needed

Work:

1. Implement `SubagentDetailsV1` and its supporting types.
2. Add constructors for initial, updated, and terminal snapshots.
3. Add bounded activity and usage aggregation helpers.
4. Add safe text/byte truncation helpers for previews.
5. Keep helpers independent of process spawning and TUI components.
6. Export a type guard for the extension's own tests and renderer.

Acceptance criteria:

- Initial state uses the outer `toolCallId` and is protocol-valid.
- State transitions cannot accidentally retain active tools after terminal settlement.
- Activity remains ordered and capped at 20 entries.
- Usage aggregation handles missing/zero fields.
- Unicode truncation respects the configured byte cap.

Verification:

```bash
cd /Users/jer/.dotfiles/stowables/pi/.pi/agent
bun test extensions/subagent/protocol.test.ts
npm run typecheck
```

---

### SA-02 — Build a streaming child-Pi JSON runner

Status: implemented and verified in the uncommitted extension working tree

Repository: `/Users/jer/.dotfiles`

Depends on: SA-01

Files:

- Add `stowables/pi/.pi/agent/extensions/subagent/json-events.ts`
- Add `stowables/pi/.pi/agent/extensions/subagent/runner.ts`
- Add focused tests and JSONL fixtures under the same directory

Work:

1. Launch child Pi with `spawn(..., { shell: false })` so stdout can be consumed incrementally.
2. Preserve the current SDK-host-safe Pi invocation resolution.
3. Parse newline-delimited `AgentSessionEvent` JSON across arbitrary chunk boundaries.
4. Handle malformed lines as bounded diagnostics instead of crashing.
5. Consume current event names from installed Pi types, especially:
   - `turn_start` / `turn_end`;
   - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`;
   - `message_end`;
   - `agent_end` / `agent_settled` where emitted.
6. Track parallel child tools by child `toolCallId`.
7. Aggregate assistant usage only once per finalized assistant message.
8. Emit complete protocol snapshots through a callback, throttled to at most once per 50–100 ms for ordinary updates; tool boundaries and terminal states flush immediately.
9. Bound stdout fragments, stderr, output preview, and diagnostics.
10. Propagate abort and timeout through SIGTERM, then SIGKILL after a grace period; remove all listeners and timers after settlement.
11. Return a structured terminal run regardless of success, timeout, cancellation, spawn error, or invalid child output.

Do not copy stale event names such as `tool_result_end` from older examples without confirming they exist in the installed API.

Acceptance criteria:

- Fragmented and combined JSON lines parse correctly.
- Concurrent child tools appear independently and settle out of order safely.
- Timeout and user abort are distinct terminal states.
- No progress is emitted after runner settlement.
- A child that exits without a final assistant message produces an actionable failure.
- No test requires a network request or live model.

Verification:

```bash
cd /Users/jer/.dotfiles/stowables/pi/.pi/agent
bun test extensions/subagent
npm run typecheck
```

---

### SA-03 — Integrate the runner into the extension tool

Status: implemented with passing automated tests; required regular-Pi smoke test not yet recorded

Repository: `/Users/jer/.dotfiles`

Depends on: SA-02

Files:

- Refactor `stowables/pi/.pi/agent/extensions/subagent/index.ts`
- Optionally add `stowables/pi/.pi/agent/extensions/subagent/agents.ts`
- Add integration-focused extension tests

Work:

1. Preserve the public `{ agent, prompt, cwd, model? }` schema.
2. Pass the real outer `toolCallId` into the runner and protocol.
3. Emit `queued`, `starting`, and live `running` snapshots with `onUpdate()`.
4. Continue using child flags:
   - `--mode json`;
   - `--no-session`;
   - `--no-extensions`;
   - `--no-skills`;
   - `--no-prompt-templates`;
   - `--no-context-files`;
   - the selected preset tool allowlist, model, and system prompt.
5. Keep final child assistant text as model-visible result content and cap it at Pi's normal output limits.
6. Save full output to a private temporary file only when truncation occurs.
7. Add a process-wide extension semaphore, defaulting to four children and configurable with `PI_SUBAGENT_MAX_CONCURRENCY`.
8. Make queued calls abortable before spawn.
9. Preserve structured details on failures:
   - save terminal failure details by outer `toolCallId`;
   - throw so Pi marks the tool result as an error;
   - patch the saved details back in a `tool_result` handler;
   - clean the map after result handling and on `session_shutdown`.
10. Keep the regular Pi renderer functional, but make it read the same protocol instead of maintaining separate semantic state.

Acceptance criteria:

- Existing model calls remain schema-compatible.
- Regular Pi still displays a useful subagent row.
- pi-tui receives structured partial details on every lifecycle phase.
- Final success and failure tool-result messages both persist protocol details.
- Four children can run while additional calls remain visibly queued.
- Abort cleans queued and running calls and leaves no stale extension state.

Verification:

```bash
cd /Users/jer/.dotfiles/stowables/pi/.pi/agent
bun test extensions/subagent
npm run typecheck
```

Manual smoke test in regular Pi:

1. Launch one `explore` call and confirm live activity.
2. Abort one call and confirm an error result with terminal details.
3. Launch multiple sibling calls and confirm the concurrency limit.

---

### SA-04 — Add a generic tool-execution reducer to pi-tui

Status: implemented and verified in the uncommitted host working tree

Repository: `/Users/jer/dev/pi-tui`

Depends on: SA-01

Files:

- Add `src/tool-executions.ts`
- Add `src/tool-executions.test.ts`
- Update `src/types.ts`
- Update `src/controller.ts`

Work:

1. Replace the start/end-only `activeTools` bookkeeping with a pure, testable reducer keyed by outer `toolCallId`.
2. Retain generic start args, latest partial result, timestamps, and final result.
3. Handle `tool_execution_update.partialResult` instead of discarding it.
4. On `tool_execution_end`, mark the execution terminal but retain it until the corresponding persisted `toolResult` message is visible, preventing completion flicker.
5. Reconcile running IDs with `session.agent.state.pendingToolCalls` as a safety check.
6. Support multiple tools ending in a different order from their start order.
7. Derive the working message from current executions; do not clear it merely because one sibling tool ended.
8. Keep compaction, retry, and user-shell messages higher priority than the derived tool message.
9. Clear state safely on session replacement, abort, and disposal.

Acceptance criteria:

- `tool_execution_update` changes the next snapshot.
- Two parallel tools remain independently visible when one finishes.
- `agent_settled` only removes stale execution state.
- Generic non-subagent tools retain current behavior.
- Controller state does not depend on a tool's custom renderer.

Verification:

```bash
cd /Users/jer/dev/pi-tui
bun test src/tool-executions.test.ts
npm run typecheck
```

---

### SA-05 — Normalize subagent details and persist them into display items

Status: implemented and verified in the uncommitted host working tree

Repository: `/Users/jer/dev/pi-tui`

Depends on: SA-04

Files:

- Add `src/subagent.ts`
- Add `src/subagent.test.ts`
- Update `src/types.ts`
- Update `src/format.ts`
- Update `src/format.test.ts`

Work:

1. Implement a defensive `unknown`-to-view-model parser for protocol v1.
2. Reject malformed or unknown versions without throwing.
3. Add a legacy adapter for existing `{ agent, model, toolCalls, usage }` session results.
4. Preserve partial and final `details` on tool display items.
5. Derive inline `running` from the reducer's active tool IDs, not from assistant-message streaming identity.
6. Prefer live partial details while running and persisted final details after completion or resume.
7. Keep the display item as a tool with optional subagent presentation data so generic output remains available as fallback.
8. Do not include unbounded details in equality checks or UI text.

Acceptance criteria:

- A live protocol snapshot produces a normalized subagent view model.
- A final `toolResult.details` recreates the completed view after session resume.
- Existing sessions using the legacy extension details remain readable.
- Unknown schema versions render as normal tools.
- Existing formatter identity tests continue to pass.

Verification:

```bash
cd /Users/jer/dev/pi-tui
bun test src/subagent.test.ts src/format.test.ts
npm run typecheck
```

---

### SA-06 — Implement rich subagent rendering in pi-tui

Status: implemented and verified, including deterministic narrow and wide terminal checks

Repository: `/Users/jer/dev/pi-tui`

Depends on: SA-05

Files:

- Update `src/app.tsx`
- Update `src/theme.ts` only if an existing semantic color is insufficient
- Add pure presentation helpers and tests where practical

Work:

1. Add a dedicated subagent presentation inside the existing tool row.
2. Collapsed running view must show:
   - status indicator;
   - agent and model;
   - elapsed time;
   - current child tool or phase;
   - compact usage when available.
3. Expanded view must show:
   - delegated prompt;
   - canonical working directory;
   - active and recent child activity;
   - usage details;
   - live output preview or final Markdown output;
   - error and full-output path when present.
4. Add a sidebar `Subagents` group for queued/running calls. Do not mix configured tool names with running instances.
5. Preserve generic active-tool rows for other tools.
6. Add a one-second timer only while timed executions are visible so elapsed labels advance without child events.
7. Handle narrow terminals by truncating secondary labels before agent/status information.
8. Continue using the existing global `Ctrl+O` tool expansion behavior.

Suggested collapsed forms:

```text
◌ explore · gpt-5.4-mini · read src/controller.ts · 12s
✓ explore · 3 turns · 18.4k tokens · $0.0123 · 14s
× explore · timed out after 120s
```

Acceptance criteria:

- Multiple concurrent subagents have distinct rows and sidebar entries.
- Running, success, error, cancellation, and timeout are visually distinct.
- A malformed/unknown payload falls back to the generic tool card.
- Completed cards render identically after resume, excluding naturally unavailable live timing.
- No old `@earendil-works/pi-tui` component is mounted inside OpenTUI.

Verification:

```bash
cd /Users/jer/dev/pi-tui
npm run check
```

Manual checks at narrow and wide terminal widths are required.

---

### SA-07 — Cross-repository integration and regression coverage

Status: automated extension and host coverage plus narrow/wide fixture checks implemented; regular-Pi live acceptance remains

Repositories:

- `/Users/jer/.dotfiles`
- `/Users/jer/dev/pi-tui`

Depends on: SA-03, SA-06

Work:

1. Add or retain a deterministic fake-child fixture that emits delayed Pi JSON events without calling a model.
2. Exercise the installed extension through an `AgentSession` subscriber or equivalent SDK harness.
3. Verify the exact path from extension `onUpdate()` to pi-tui controller snapshot.
4. Test:
   - one successful run;
   - one failed run;
   - cancellation;
   - timeout;
   - malformed child output;
   - two sibling runs completing out of order;
   - more calls than the concurrency limit;
   - session persistence and resume.
5. Confirm generic read/bash/web-search tools have no presentation regression.
6. Update `/Users/jer/dev/pi-tui/README.md` with the ownership boundary and supported subagent UX.
7. Add extension documentation near its source describing protocol versioning, configuration, limits, and troubleshooting.

Progress recorded on 2026-07-21:

- Done: deterministic fake-child JSONL fixture and parser/runner tests.
- Done: installed resource-loader check and `AgentSession` transport test for parallel updates, success/failure details, persistence, and resume.
- Done: extension scenarios for malformed output, cancellation, timeout, out-of-order sibling completion, concurrency queuing, and process cleanup.
- Done: extension `README.md` describing ownership, protocol versioning, configuration, limits, and troubleshooting.
- Done: pass protocol-shaped extension updates through the pi-tui controller reducer and display-item formatter, including actual controller snapshot construction.
- Done: host tests for success, failure, cancellation, timeout, malformed details, sibling ordering, queued concurrency, resume, extension absence, and generic-tool regressions.
- Done: host `README.md` ownership and supported-UX documentation.
- Done: deterministic protocol fixture checks at 80x28 and 140x36, plus expanded rendering at 140x50.
- Remaining: run the regular-Pi live smoke test; the final pi-tui live-model smoke remains optional.

Acceptance criteria:

- All scenarios pass without network access except the final optional live smoke test.
- No child process survives abort, timeout, or test teardown.
- No full child transcript is written into parent session details.
- A regular Pi client continues to use the extension successfully.
- pi-tui continues to work when the extension is absent.

Verification:

```bash
cd /Users/jer/.dotfiles/stowables/pi/.pi/agent
bun test extensions/subagent
npm run typecheck

cd /Users/jer/dev/pi-tui
npm run check
```

Optional live smoke test:

```bash
cd /Users/jer/dev/pi-tui
npm start -- --no-session
```

---

### SA-08 — Optional trusted preset discovery

Status: deferred until SA-07 is accepted

Repository: `/Users/jer/.dotfiles`

Depends on: SA-07

Work:

1. Define user-level agent files with validated frontmatter for name, description, model, tools, timeout, and system prompt.
2. Continue shipping `explore` as a trusted built-in preset.
3. Load user presets from a trusted global location.
4. Do not load project-local presets until the host has a working confirmation flow and `ctx.isProjectTrusted()` is true.
5. Require explicit opt-in for write-capable tools.
6. Include preset source and capability summary in protocol details.

This task must receive a separate security review before implementation. It is not required for the first rich subagent release.

---

## 7. Parallel execution map

After SA-01:

```text
SA-01 protocol
  ├── SA-02 extension runner ── SA-03 extension integration ──┐
  └── SA-04 host reducer ── SA-05 normalization ── SA-06 UI ─┤
                                                            └── SA-07 integration
                                                                    └── SA-08 optional presets
```

SA-02 and SA-04 may be assigned to separate agents after SA-01. Do not begin SA-03 before SA-02 or SA-05 before SA-04.

## 8. Global definition of done

The first release is complete when:

- SA-01 through SA-07 acceptance criteria pass;
- both repositories typecheck and test successfully;
- live updates are driven by structured details, not tool-name special cases;
- concurrent runs remain independently accurate;
- abort and timeout terminate child processes;
- terminal details survive parent session persistence and resume;
- generic tool behavior and extension-free pi-tui behavior remain intact;
- regular Pi still runs the extension without pi-tui;
- documentation clearly says that subagents are supplied by an extension, not Pi core.

## 9. Deferred upstream opportunities

These are not blockers and must not be implemented in vendored `node_modules`:

1. Add streaming stdout/stderr callbacks to `pi.exec()` so extensions need not own `spawn()`.
2. Add an error type or result path that preserves structured `details` when a tool fails.
3. Add a renderer-neutral optional tool-presentation metadata convention.
4. Add host APIs for cancelling one active tool call rather than aborting the whole parent run.
