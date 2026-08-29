# Subagent extension

This extension supplies the `explorer` and `worker` spawn tools plus `subagent_wait`, `subagent_check`, and `subagent_cancel` for session-scoped background work. Those five are the whole tool set. Subagents are **not a Pi core feature**: the extension owns its Profiles, queuing, child-process execution, cancellation, Limits, and progress snapshots. Progress reaches the host over the Background Protocol on `pi.events`; the tool results themselves are plain text plus the Job snapshot.

## Tool shape

Each Profile is a spawn tool. Both take the same arguments and return a Job id at once:

```ts
{
  prompt: "Locate and explain the relevant code",
  cwd: "/absolute/or/relative/path",
  model?: "provider/model:thinking",
  name?: "short title for the Job"
}
```

| Profile | Capabilities | Prompt | Default model | Limits |
| --- | --- | --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls` | Replaces Pi's coding prompt with a read-only exploration prompt | `openrouter/z-ai/glm-5.3-flash:low` | 60 min wall clock, 10 min stall, 15 min tool stall |
| `worker` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | Pi's normal coding prompt plus bundled [Ponytail](https://ponytail.dev/) minimal-coding standards | `openrouter/z-ai/glm-5.3-flash:high` | 60 min wall clock, 10 min stall, 15 min tool stall |

Each Profile lives in its own directory under [`profiles/`](./profiles/) holding its declaration (`index.ts`) and `prompt.md`; `profiles/profile.ts` supplies the default Limits and the child argument list, and `profiles/index.ts` lists what gets registered.

The worker reads repository guidance itself, completes the delegated task, edits files, runs focused validation, and returns a concise handoff. Its self-contained, vendored Ponytail guidance favors existing code, the standard library, native platform features, installed dependencies, and the smallest correct diff while preserving validation, error handling, security, and accessibility. The upstream license is preserved in [`profiles/worker/prompt.LICENSE`](profiles/worker/prompt.LICENSE).

Both Profiles disable child sessions, extensions, skills, prompt templates, and automatic context-file loading. The worker prompt tells the child to discover `AGENTS.md` and contribution documentation before editing. No project-local or user-defined Profiles are loaded, and the child cannot recursively load this extension.

Relative working directories resolve from the parent session's working directory. `~`, `~/...`, and the accidental leading `@` commonly produced by models are normalized before the directory is canonicalized.

## Background jobs

`explorer` and `worker` validate the prompt and working directory, then immediately return a Job id while the child waits on the process-wide FIFO concurrency limit. Continue useful parent work after spawning. Use `subagent_check` for non-blocking inspection, `subagent_wait` only when progress depends on results, and `subagent_cancel` for explicit cancellation. Aborting a wait never cancels its jobs.

Background completion is delivered exactly once as a persisted `subagent-result` custom message unless a wait consumes it first. Completion while the parent is busy is deferred until `agent_settled`; idle completion is delivered immediately. Wait and automatic-delivery output have smaller budgets within Pi's 50KB/2000-line hard ceiling, and truncated complete output retains a private file path.

The extension emits complete version-1 snapshots on `pui.subagent.background` through `pi.events`. Envelopes use schema `pi.subagent.background` and include the current `sessionId` and a fresh extension `instanceId`; jobs include bounded title, prompt, activity, preview, diagnostics, paths, and the existing `SubagentRunV1`. At most 64 jobs are tracked, pruning the oldest terminal entries first. Hosts may explicitly cancel a job with a bounded version-1 `pi.subagent.background.control` message on `pui.subagent.background.control`; controls are accepted only when both session and extension instance match, and the listener is removed during shutdown.

Reload, session replacement, fork, and quit abort all queued/running background jobs. Shutdown waits concurrently for settlement with a bounded teardown, clears deferred results, removes full-output directories created by this extension, emits `reset`, and never sends stale result messages or writes a late spill. Jobs are intentionally not restored or reattached.

## Security boundary

> **Worker Jobs are write-capable and not sandboxed.** They can edit files and execute arbitrary shell commands. The child inherits the parent process environment, `cwd` is only its starting directory, and process/context isolation does not confine filesystem or operating-system access. Use write-capable delegation only in trusted repositories.

The explorer's Pi tool allowlist is read-only, but it is likewise not an operating-system sandbox and does not confine reads to `cwd` or scrub the inherited environment.

## Run state

Every Job carries one `SubagentRunV1` defined in [`run-state.ts`](./run-state.ts): status, phase, timestamps, at most 64 active child tools, at most 20 recent activity entries, aggregate usage, an output preview, an error, and the retained full-output path. The manager republishes the complete run on every transition, never a delta, and the Background Protocol validates it before the host renders anything. Run state contains no raw child transcript or unbounded stdout/stderr.

## Limits

Every Job runs under three Limits. The child runner in [`child-agent.ts`](./child-agent.ts) enforces them on an injected clock.

| Limit | Default | Counts from | Terminal status |
| --- | --- | --- | --- |
| Wall clock | 60 minutes | spawn, regardless of activity | `timed_out` |
| Stall | 10 minutes | the newest child event, while no tool is active | `stalled` |
| Tool stall | 15 minutes | the newest child event, while a tool is active | `tool_stalled` |

Any child event resets the stall timers: turn boundaries, tool start and end, streaming tool output (`tool_execution_update`), and assistant message updates. A long `bash` command that keeps printing stays alive; one that goes quiet for 15 minutes does not. The child's own event timestamps never feed the timers, so a child cannot postpone a Limit by reporting future times.

When a Limit fires, the runner appends a diagnostic activity naming it (`Wall clock limit reached`, `Stall limit reached`, `Tool stall limit reached`), sends SIGTERM to the child's whole process group, and escalates to SIGKILL after two seconds. The Job's error starts with a sentence naming the Limit and its value, for example `Subagent's active tool produced no output for 15 minutes (tool stall limit).`

Defaults live in `DEFAULT_LIMITS` in [`profiles/profile.ts`](./profiles/profile.ts). A Profile overrides any of the three in its `defineProfile` call; a value of `0` disables that Limit. Tool descriptions state each Profile's effective Limits. There is no environment variable for Limits.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `PI_SUBAGENT_MAX_CONCURRENCY` | `4` | Process-wide child limit (valid range 1 to 64) |
| `PI_WORKER_MODEL` | `openrouter/z-ai/glm-5.3-flash:high` | Model for the `worker` Profile |
| `PI_EXPLORER_MODEL` | `openrouter/z-ai/glm-5.3-flash:low` | Model for the `explorer` Profile |
| Activity history | 20 entries | Bounds persisted progress metadata |
| Model-visible output | 50 KB or 2000 lines | Pi's normal tool-output limits |

A call's non-empty `model` value always overrides model selection. Otherwise the Profile consults `PI_WORKER_MODEL` or `PI_EXPLORER_MODEL`, then uses its default.

Jobs are the concurrency unit. Additional Jobs stay visibly queued and can be cancelled before they spawn. Cancellation and each of the three Limits are separate terminal statuses.

If final output exceeds the model-visible limit, the extension writes the complete assistant output to a mode-`0600` file in a private temporary directory and includes its path in the result. The file remains available for inspection during the active session and is removed at session shutdown. Paths supplied by the child runner remain externally owned and are not removed. No file is created for untruncated output.

## Troubleshooting

- **`Unable to start child Pi`**: ensure `pi` is on `PATH`. When the parent is Pi's CLI, the extension safely reuses that CLI entrypoint; SDK hosts do not reuse their own `argv[1]`.
- **Exited without a final assistant response**: inspect the bounded stderr/diagnostic in the failed tool result. Malformed JSONL lines are reported as diagnostics rather than crashing the parent.
- **Timed out, stalled, or tool stalled**: the error names the Limit that fired. Narrow the delegated prompt, or change that Limit in the Profile's `profiles/<name>/index.ts` after review.
- **Calls remain queued**: inspect `PI_SUBAGENT_MAX_CONCURRENCY`; invalid values fall back to four.
- **Full output path missing after truncation**: the result remains usable, but the private temporary file could not be created.

## Verification

From the repository root:

```bash
bun run check
```

For a focused extension run, use `bun test modules/subagents`. Tests use `fixtures/fake-child.mjs` and do not call a model or the network.
