# Codebase simplification plan

Status: planned

## 1. Objective

Reduce the amount of state and cross-module knowledge needed to change pi-tui while preserving current behavior.

The repository is healthy: the default check passes 63 tests, and broad copy-paste duplication is low. The main maintenance cost comes from two large orchestration files, opaque display reconciliation, and a process runner that combines several lifecycle concerns.

This plan favors a small number of cohesive modules and pure functions. It does not introduce a service framework or split every component into its own file.

## 2. Desired outcome

The cleanup is complete when:

- `App` primarily composes the screen and routes global actions;
- `PiTuiController` primarily owns Pi runtime and session orchestration;
- command metadata, parsing, and autocomplete cannot drift independently;
- display items are explicitly typed and reconciled without reflective field inspection;
- unused snapshot state and opaque extension payloads do not reach the UI;
- child event projection and terminal outcome classification are independently testable;
- all source and test files pass TypeScript checking;
- current runtime, subagent, persistence, and generic-tool behavior remains covered.

## 3. Current hotspots

### `src/app.tsx`

The file currently owns:

- application composition;
- prompt text and completion requests;
- global keyboard routing;
- model, session, and command dialogs;
- transcript and subagent rendering;
- prompt, sidebar, toast, picker, and help components.

This makes unrelated UI changes collide in one file and leaves key-routing behavior difficult to test.

### `src/controller.ts`

The controller currently owns:

- session creation, replacement, and extension binding;
- event coalescing and tool execution state;
- display identity and snapshot construction;
- autocomplete provider assembly;
- slash-command parsing;
- shell commands, notifications, and model/session actions.

The class should keep orchestration responsibilities but delegate pure policy and data-shaping work.

### Display projection

`DisplayItem` groups several kinds behind optional fields, so the UI relies on casts. Tool-item construction has two paths, and controller reconciliation discovers comparable fields dynamically while special-casing opaque details.

### Subagent runner

The runner is well tested but combines event parsing, projection, throttled publication, process supervision, signal escalation, and terminal status classification in one function. This is the highest-risk refactor and should happen last.

### Documentation and checks

The repository previously kept two long, completed subagent implementation plans. Their durable design decisions now live in [`subagent-architecture.md`](subagent-architecture.md). Extension tests run under Bun but are excluded from the default TypeScript project.

## 4. Principles and constraints

1. Preserve behavior before moving boundaries.
2. Prefer pure functions over new stateful service classes.
3. Keep the number of UI modules small and responsibility-based.
4. Preserve object identity where OpenTUI streaming stability depends on it.
5. Keep the subagent producer and defensive consumer validators independent.
6. Keep [`src/bundled-extensions.ts`](../src/bundled-extensions.ts) as the tested registration seam.
7. Do not combine dependency upgrades with structural refactors.
8. Do not edit generated or vendored code under `node_modules`.
9. Keep every task independently reviewable and leave `npm run check` green.

## 5. Work packages

### SIM-01 — Strengthen refactor guardrails

Status: planned

Depends on: none

Primary files:

- `src/index.tsx`
- add `src/cli.ts`
- add `src/cli.test.ts`
- `src/controller.test.ts`
- `src/format.test.ts`
- `tsconfig.json`
- extension test files as needed

Work:

1. Move argument parsing and usage text from `src/index.tsx` into a side-effect-free CLI module.
2. Test help, session, cwd, continue, no-session, prompt, missing-value, and unknown-option cases.
3. Add focused display reconciliation tests before changing identity behavior.
4. Replace controller tests that invoke private methods through casts with tests of extracted reducers or supported test seams.
5. Typecheck extension tests instead of excluding them broadly:
   - enable `.ts` imports for no-emit checking;
   - fix strict-null issues exposed by the full project;
   - retain Bun as the test runner.
6. Record the existing manual narrow/wide OpenTUI checks for later comparison.

Acceptance:

- CLI parsing can be imported without starting the TUI.
- No test reaches a private controller method through a cast.
- All source and test TypeScript files pass the configured typecheck.
- `npm run check` passes.

### SIM-02 — Make the snapshot and display model explicit

Status: planned

Depends on: SIM-01

Primary files:

- `src/types.ts`
- `src/format.ts`
- `src/controller.ts`
- `src/app.tsx`
- related tests

Work:

1. Replace the broad display union with explicit exported types for text, tool, and shell items.
2. Remove UI casts and non-null assertions that exist only because the union is imprecise.
3. Extract one tool display-item builder used by both persisted assistant calls and event-only executions.
4. Replace reflective `sameDisplayItem()` comparison with an explicit, kind-aware presentation key or equality function.
5. Keep normalized subagent presentation in the UI model, but remove raw `partialDetails` and `resultDetails` from `PiTuiSnapshot` unless a real UI consumer is identified.
6. Remove unused snapshot properties:
   - `revision`;
   - `sessionFile`;
   - exported `isRetrying`;
   - `activeToolNames`.
7. Render the existing `workingMessage` in the prompt footer so compaction, retry, shell, and tool status logic has a user-facing purpose. If that presentation is rejected during review, remove the complete `workingMessage` state path instead of retaining dead snapshot state.
8. Keep display objects stable while their presentation key is unchanged so streaming Markdown does not flicker.

Acceptance:

- The app contains no `DisplayItem & {...}` casts.
- Tool display-item construction has one implementation.
- Reconciliation does not enumerate arbitrary object fields or carry opaque extension payloads into the reactive store.
- Streaming identity, partial tool updates, persisted results, legacy subagents, and generic fallback retain coverage.
- `npm run check` passes.

### SIM-03 — Decompose the OpenTUI view layer

Status: planned

Depends on: SIM-02

Primary files:

- `src/app.tsx`
- add `src/ui/transcript.tsx`
- add `src/ui/prompt.tsx`
- add `src/ui/dialogs.tsx`
- add `src/ui/sidebar.tsx`
- add focused pure helper tests where useful

Work:

1. Move transcript concerns into `ui/transcript.tsx`:
   - welcome state;
   - message dispatch;
   - generic tool and shell cards;
   - subagent cards;
   - queued messages.
2. Move prompt and completion presentation into `ui/prompt.tsx`.
3. Move dialog, picker, and help presentation into `ui/dialogs.tsx`.
4. Move sidebar and toast presentation into `ui/sidebar.tsx`.
5. Keep shared application state and global action routing in `App`; do not create a global context merely to avoid explicit props.
6. Replace duplicate model/session loading-dialog setup with one typed async picker helper.
7. Represent command-palette entries as typed descriptors and dispatch through an action map rather than a switch over loosely typed string arrays.
8. Extract pure key predicates for Enter variants and other repeated key combinations.
9. Keep completion cancellation and request-order protection intact.

Acceptance:

- `src/app.tsx` reads as screen composition and high-level interaction orchestration.
- No new module contains only a trivial wrapper component.
- Model and session picker loading/error behavior uses one implementation.
- Prompt completion, external editor, abort, queueing, sidebar, and dialog behavior remains unchanged.
- Manual narrow and wide terminal checks pass.

### SIM-04 — Narrow controller policy

Status: planned

Depends on: SIM-02; may proceed alongside SIM-03 after shared type changes settle

Primary files:

- `src/controller.ts`
- add `src/commands.ts`
- add or expand `src/autocomplete.ts`
- `src/prompt-autocomplete.ts`
- related tests

Work:

1. Create a canonical local command catalog containing:
   - command name;
   - aliases;
   - description and argument hint;
   - parsed action.
2. Generate local slash autocomplete entries from that catalog.
3. Parse local commands through a pure function, preserving pass-through behavior for extension commands and prompt templates.
4. Move autocomplete provider assembly into a focused factory that accepts the current session resources and model-list callback.
5. Replace the custom PATH scanner with Bun's executable lookup if it preserves supported platform behavior.
6. Add a private `runAndNotify` helper for repeated asynchronous action error handling.
7. Keep runtime creation, extension binding, session replacement, refresh scheduling, and public user actions in the controller.
8. Keep toast lifecycle in the controller unless extraction removes meaningful complexity; do not add a toast service solely for architectural symmetry.

Acceptance:

- Command aliases, parsing, help metadata, and autocomplete are derived from one source.
- Unknown and extension commands still reach Pi normally.
- Model, session, reload, compact, shell, and abort behavior is unchanged.
- The controller no longer owns pure command or autocomplete policy.
- `npm run check` passes.

### SIM-05 — Separate subagent event projection from process supervision

Status: planned

Depends on: SIM-01 through SIM-04

Primary files:

- `extensions/subagent/runner.ts`
- add `extensions/subagent/event-state.ts`
- add `extensions/subagent/outcome.ts`
- `extensions/subagent/index.ts`
- optionally add `extensions/subagent/agents.ts`
- optionally add `extensions/subagent/render.ts`
- related tests and fixtures

Work:

1. Extract a pure child-event projector that accepts the current protocol state and one decoded Pi event, then returns updated state and publication intent.
2. Keep malformed-event handling bounded and non-throwing.
3. Extract terminal outcome classification from process control. Inputs should include termination reason, spawn error, exit status, final assistant message, stderr, and diagnostics.
4. Leave spawn, stream listeners, timers, process-group signaling, and cleanup in the runner.
5. Preserve forced publication at tool boundaries and terminal settlement.
6. Move preset definitions and argument construction out of extension registration if doing so produces a cohesive module.
7. Move regular-Pi rendering out of `index.ts` if it can depend only on protocol details and result content.
8. Keep failure-detail retention and the `tool_result` persistence workaround close to registration because they are Pi extension lifecycle concerns.
9. Do not replace intentional exception suppression around progress callbacks or already-exited child signaling with errors that could strand a process.
10. Do not merge the producer validator with `src/subagent.ts`. If shared literals are considered, verify that explicit regular-Pi loading and bundled resource loading still resolve every import.

Acceptance:

- Event projection and terminal classification have direct unit tests.
- Timeout and cancellation remain distinct.
- Spawn failure, malformed JSONL, missing final output, nonzero exit, abort, and process-group cleanup retain coverage.
- No progress is emitted after settlement.
- Regular Pi and pi-tui continue to consume the same protocol.
- `npm run check` passes.

### SIM-06 — Final repository and documentation pass

Status: planned

Depends on: SIM-03 through SIM-05

Primary files:

- `README.md`
- `docs/subagent-architecture.md`
- `extensions/subagent/README.md`
- `package.json`
- launcher tests or scripts

Work:

1. Update architecture documentation to match the final module boundaries.
2. Keep one canonical verification command in user-facing documentation, with focused commands only where they add value.
3. Add a lightweight `pi-tui --help` launcher smoke test that does not require a TTY or installed model.
4. Align the internal package name, project title, and `pi-tui` command terminology, or document why they intentionally differ.
5. Review exports and snapshot fields for newly dead API surface.
6. Reconcile the repository's TODO list with tracked issues or explicitly maintained documentation.
7. Run clean-install, automated, and manual checks without combining unrelated dependency upgrades.

Acceptance:

- Current documentation describes the code that exists rather than completed migration steps.
- No stale paths, duplicate verification instructions, or historical implementation checklists remain in active docs.
- A clean install and `npm run check` pass.
- Launcher help works without entering OpenTUI.

## 6. Execution order

```text
SIM-01 guardrails
  -> SIM-02 snapshot and display model
       -> SIM-03 UI decomposition ---------┐
       -> SIM-04 controller policy --------┤
                                           -> SIM-05 subagent runner
                                                -> SIM-06 final pass
```

SIM-03 and SIM-04 may proceed in parallel only after SIM-02 stabilizes shared types. Avoid parallel edits to `src/app.tsx` or `src/controller.ts` themselves.

Each work package should be one reviewable pull request or a short sequence of behavior-neutral and behavioral commits. Do not combine SIM-05 with unrelated UI changes.

## 7. Verification

Run after every work package:

```bash
npm run check
```

Run focused extension checks during SIM-05:

```bash
bun test extensions/subagent
```

Final manual verification:

1. Launch from outside the repository with `--no-session`.
2. Check narrow and wide layouts.
3. Send a normal prompt and a prompt while streaming.
4. Exercise model, session, command, and help dialogs.
5. Run generic and subagent tools, including siblings.
6. Abort a run and confirm process cleanup.
7. Run `/reload`, `/new`, and resume a completed session.
8. Load the subagent extension explicitly in regular Pi.

## 8. Non-goals

- Replacing Solid or OpenTUI.
- Replacing Bun or changing package managers.
- Redesigning the visual theme.
- Adding write-capable or project-defined subagent presets.
- Changing the `pi.subagent` protocol version.
- Publishing the extension as a separate package.
- Introducing dependency injection or service-container frameworks.
- Upgrading Pi, OpenTUI, TypeScript, or other dependencies as part of structural cleanup.

## 9. Definition of done

The plan is complete when all work-package acceptance criteria pass, active documentation reflects the resulting architecture, and the application preserves:

- startup and shutdown behavior;
- session replacement and persistence;
- prompt steering and follow-up queueing;
- model, thinking, compaction, reload, and shell actions;
- generic tool progress and output;
- live, failed, cancelled, timed-out, and restored subagent cards;
- standalone regular-Pi extension loading.
