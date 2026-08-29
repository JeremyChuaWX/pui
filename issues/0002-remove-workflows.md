---
id: 0002
title: Remove workflows and fold the child-agent runtime into a leaner subagents Module
status: open
labels: [ready-for-agent, refactor]
created: 2026-08-29
---

# Remove workflows and fold the child-agent runtime into a leaner subagents Module

## Problem statement

The workflows feature never earned its place. It is 9,000 lines (larger than the other three
Modules combined and larger than the whole UI), it carries its own worker runtime, durable
storage, worktrees, approvals, an RPC layer, a headless CLI mode, a full-screen UI page, and a
public authoring API, and I don't use it. Every other part of the codebase pays for it: the
Child-Agent Runtime exists as a Shared Primitive only because workflows was a second consumer,
the App layer has a Host Entry concept only because headless workflow runs needed one, the
confirm dialog cap is sized for 64 KiB scripts, and the smoke build tests workflow plumbing
instead of the things pui actually ships.

Meanwhile the standalone subagents extension in my local `~/.pi/agent` setup, ported from pui,
has already shown that the same feature works with two spawn tools, three management tools, a
three-part watchdog, and Pi's own follow-up delivery. pui still carries the older, heavier shape:
a blocking tool with its own live-rendering protocol, a `generic` role, hand-rolled deferred
result delivery, and a single timeout.

## Solution

Delete the workflows Module and everything that only existed for it. Then reshape the subagents
Module toward the local extension's design while keeping the pui-specific part that the local
setup lacks: the custom UI. Subagents becomes the sole owner of child-agent spawning (Profiles,
Limits, the process-wide semaphore), exposes `explorer` and `worker` as spawn tools plus
`subagent_check`, `subagent_wait`, and `subagent_cancel`, delivers results through Pi's
`followUp` mechanism, and keeps publishing the Background Protocol so the sidebar and palette
keep showing Jobs. Shared code shrinks to what has two or more consumers.

## User stories

1. As a pui user, I want the `workflow` subcommand, `/workflow`, `/workflows`, the workflows sidebar section, and the workflow page gone, so that the client only offers features I use.
2. As a pui user, I want no leftover workflow state on disk (`.pui/` in the repo, `workflow-runs`, `workflow-worktrees`, and `workflow-approvals.json` under my Pi agent directory), so that the removal is complete.
3. As the Pi model, I want `explorer` and `worker` as the two spawn tools, so that choosing a Profile is choosing a tool rather than passing an `agent` argument.
4. As the Pi model, I want `subagent_check`, `subagent_wait`, and `subagent_cancel`, so that I can inspect, block on, and stop Jobs without a list tool or a blocking spawn.
5. As the Pi model, I want a finished Job delivered as a follow-up message that starts a turn when I'm idle and queues when I'm busy, so that results never interrupt or get lost.
6. As the Pi model, I want tool descriptions that state the Profile's tools, model, and Limits, so that I pick the right Profile without reading docs.
7. As a pui user, I want every Job bound by a wall clock, a stall timeout, and a tool-stall timeout, so that a looping child, a hung model stream, or a wedged command all end on their own.
8. As a pui user, I want streaming tool output to reset the tool-stall timer, so that a long but healthy command is not killed.
9. As a pui user, I want the `explorer` Profile read-only and the `worker` Profile write-capable, with the same tool allowlists as my local setup, so that both installs behave the same.
10. As a pui user, I want Profile models to default to the same GLM models as my local setup, overridable with `PI_WORKER_MODEL` and `PI_EXPLORER_MODEL`, so that the binary can differ from local without a rebuild.
11. As a pui user, I want `PI_SUBAGENT_MAX_CONCURRENCY` to keep limiting concurrent children process-wide, so that spawning stays bounded.
12. As a pui user, I want the sidebar to keep listing active and recent Jobs with status, elapsed time, and title, so that the custom UI remains the reason to run pui over plain pi.
13. As a pui user, I want to cancel a Job from the command palette, so that a runaway child is one keystroke away from stopping.
14. As a pui user, I want a Job's completion to appear in the transcript as a result message with a path to the full output when it was truncated, so that nothing is lost when output is large.
15. As a pui user, I want Jobs aborted on reload, session switch, fork, and quit, so that no orphaned children survive a session.
16. As a UI developer, I want the subagents UI Entry to keep exposing the Background Protocol parser, reducer, and bridge, so that views never touch wire formats.
17. As a UI developer, I want the Background Protocol to keep bounding every untrusted string and validating session and instance ids, so that a misbehaving extension cannot break rendering.
18. As a UI developer, I want the confirm dialog cap reduced to a size that matches real extension use, so that the bound is honest rather than sized for a deleted feature.
19. As a pui maintainer, I want the subagents Module to own Profiles, Limits, the child process runner, the JSONL event parser, process-tree signalling, and the semaphore, so that the Module is self-contained and mirrors my local extension's layout.
20. As a pui maintainer, I want each Profile declared in its own directory beside its prompt file, so that adding a Profile is one directory and one list entry.
21. As a pui maintainer, I want the shared library reduced to code with two or more consumers, so that "shared" means shared.
22. As a pui maintainer, I want the Host Entry concept and its boundary rule removed, so that the App layer never imports a Module and the Interfaces Directory is just `pi` and `ui`.
23. As a pui maintainer, I want the smoke build to prove the compiled binary registers every bundled tool and the bundled skill, so that the build gate still covers packaging.
24. As a pui maintainer, I want the boundary checker's fixtures to reference surviving Modules, so that the checker's tests don't describe deleted paths.
25. As a pui maintainer, I want the glossary, architecture doc, README, and contribution doc to describe only what exists, so that agents and humans don't act on stale structure.
26. As a future maintainer, I want an ADR recording that subagents owns the child-agent runtime and superseding ADR 0001, so that nobody re-extracts a Shared Primitive with one consumer.
27. As a pui maintainer, I want the version bumped to 0.9.0, so that the removal of a tool and a package export is marked as breaking.
28. As a reviewer, I want the whole change in one PR on one branch, so that the deletion and the reshape are reviewed as the single decision they are.
29. As a pui user, I want `web_crawl`, `web_search`, `fd`, and `rg` unchanged, so that the other Modules are untouched by this work.

## Implementation decisions

- Delete the workflows Module in full, including its worker runtime, durable storage, worktrees,
  approvals, RPC layer, authoring API, and guidance document. Delete the headless workflow entry
  and the workflow smoke entry from the App layer; the `workflow` subcommand and `--workflow-smoke`
  flag disappear from the CLI and its help text.
- Remove every workflow concept from the UI: the workflow page, workflow view helpers, the
  Workflows sidebar section, the `/workflow` and `/workflows` commands, the workflow palette
  entry and its run/phase/agent submenu tree, the workflow transcript renderer, and the
  workflow-specific fields on display items, snapshots, and prompt actions. Esc/Ctrl+C page
  dismissal logic that only served the workflow page goes with it.
- Remove `pui-workflow` from the Register File and drop the `./workflow` package export; the
  package `exports` map is removed entirely since nothing else is exported.
- Reduce the confirm dialog message cap from 72 KiB to 16 KiB and reword its comment as a bound
  on untrusted extension content.
- Delete the repo's `.pui/` directory and its gitignore entry, and delete `workflow-runs`,
  `workflow-worktrees`, and `workflow-approvals.json` from the user's Pi agent directory.
- Subagents tool set: `explorer` and `worker` spawn a Job under the matching Profile and return
  its id immediately; `subagent_check` inspects one Job without consuming its result;
  `subagent_wait` blocks on one or more Jobs and consumes their results; `subagent_cancel`
  cancels queued or running Jobs and awaits terminal state. The blocking `subagent` tool,
  `subagent_spawn`, `subagent_list`, the `generic` role, and the `pi.subagent` tool-details
  protocol with its transcript renderer and normalisation view model are removed.
- Profiles: `explorer` (read-only tools `read`, `grep`, `find`, `ls`; replaces the system
  prompt) and `worker` (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; appends to the
  system prompt, carrying the vendored Ponytail guidance and its license). Default models are
  the local setup's `openrouter/z-ai/glm-5.3-flash:low` for `explorer` and `:high` for
  `worker`, overridable via `PI_EXPLORER_MODEL` and `PI_WORKER_MODEL`. Each Profile is a
  directory holding its declaration and `prompt.md`; a shared profile type supplies default
  Limits and the child argument list; a single index lists what gets registered.
- Limits: every Job runs under a 60 minute wall clock, a 10 minute stall timeout while no tool
  is active, and a 15 minute tool-stall timeout while one is; streaming bash output resets the
  tool-stall timer. Defaults live with the Profile type and are overridable per Profile. The
  child-agent runner is ported from the local extension rather than patched from pui's.
- Result delivery uses Pi's `sendMessage` with `deliverAs: "followUp"` and `triggerTurn: true`.
  The hand-rolled deferred-result map and the `agent_settled` hook are removed. Truncated results
  keep a path to the retained full output.
- The Background Protocol is kept as the UI contract: versioned envelope with session id and
  extension instance id, bounded Job fields, at most 64 tracked Jobs with oldest-terminal
  pruning, the control channel for cancellation with session and instance matching, and a `reset`
  on shutdown. The Job type is renamed from `SubagentRunV1` to `SubagentJobV1`. No `/subagents`
  dashboard command is added; the sidebar and palette are the dashboard.
- Module layout: the Child-Agent Runtime Shared Primitive is dissolved into the subagents Module
  along with the semaphore, instance-scoped runs, background channel, and JSONL event parser,
  which have no other consumer. The shared library keeps retained output, bounded process, and
  validation, each of which has at least two consumers.
- The Host Entry is removed from every Module and from the boundary checker's rules. The
  Interfaces Directory is `pi` (required) plus `ui` (where the UI needs it). The App layer never
  imports a Module.
- The smoke build replaces the workflow smoke with a headless `--smoke` entry that boots the
  runtime, asserts every bundled tool (`fd`, `rg`, `explorer`, `worker`, `subagent_check`,
  `subagent_wait`, `subagent_cancel`, `web_crawl`, `web_search`) and the `unslop` skill are
  registered, prints a JSON result, and exits.
- ADR 0002 supersedes ADR 0001: subagents owns Profiles and the child-agent runner because there
  is one consumer, and a shared layer with one consumer is indirection without reuse.
- Docs: glossary already updated (workflows, Child-Agent Runtime, Agent Role, and Host Entry
  retired; Profile, Job, Limits, Background Protocol added). Architecture doc, README, and
  contribution doc are rewritten to match. Issue 0001 and the scratch notes are left as history.
- Version 0.9.0. One branch, one PR, deletion commits first, then the reshape.

## Testing decisions

- A good test drives a seam with inputs and asserts on observable outputs (registered tools,
  emitted events, sent messages, snapshots, process exit codes). It does not assert on file
  layout, private state, or which internal function was called. Timing behaviour is tested with
  injected clocks and scripted child events, never real sleeps.
- Extension seam (primary): the subagents Extension registered into the reusable ExtensionAPI
  harness with an injected fake child spawner. Covers: the five tools and no others are
  registered; `explorer` and `worker` pass the right tool allowlist, model flag, prompt flag, and
  isolation flags to the child; env overrides win over defaults; a finished Job sends one
  `followUp` message with `triggerTurn`; wait consumes, check does not; cancel reaches terminal
  state; each of the three Limits ends a Job with the right status and diagnostic; streaming
  output resets the tool-stall timer; Background Protocol snapshots are emitted on every
  transition and `reset` on shutdown; controls with a mismatched session or instance are
  ignored. Prior art: the existing subagents Extension integration tests.
- Controller seam: a real runtime with the bundled Extensions, asserting the snapshot carries
  background Jobs and no workflow fields, and that Jobs are aborted across new session, switch,
  fork, and dispose. Prior art: the controller background lifecycle tests and the controller
  tests.
- Register File seam: bundled factory names and per-factory tool names, with `pui-workflow`
  absent. Prior art: the register tests.
- Built-binary seam: the smoke build runs `--help` and `--smoke` against the compiled binary and
  checks the printed JSON. Prior art: the existing smoke build.
- Boundary seam: the boundary checker's fixtures use subagents and web paths; a fixture proves an
  App-layer import of a Module is rejected and that `host` is no longer a recognised entry.
  Prior art: the boundary checker tests.
- UI view tests for the workflow page and workflow view are deleted; subagent sidebar helpers
  keep their existing tests, updated for the `Job` rename.

## Out of scope

- Any change to the web or file-search Modules; `web_crawl` stays.
- A `/subagents` dashboard command or a footer status line.
- Sharing code between pui and the local `~/.pi/agent` extensions; local is a reference, not a
  target.
- User-defined or project-local Profiles.
- Session-persisted or reattachable Jobs.
- A replacement scripting or authoring API for what workflows did.
- Converting the boundary checker into a general dead-code or cycle detector.

## Further notes

- The local extension's `child-agent.ts`, `profiles/`, `manager.ts`, `jobs.ts`, `json-events.ts`,
  `process.ts`, and `semaphore.ts` are the reference implementation for the reshape. pui keeps
  what the local setup lacks: the versioned Background Protocol, instance authority, string
  bounds, and the UI Entry that consumes them.
- The `.pui/` scripts (`implement-review-validate.ts`, `pr-ai-review-pass.ts`) import
  `pui/workflow` and are deleted with it. If a pattern from them proves useful later it becomes a
  `worker` prompt, not a runtime.
