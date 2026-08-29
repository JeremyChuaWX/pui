# Subagents module

This Module owns background child Pi processes. Its Extension registers the `explorer` and `worker` spawn tools plus `subagent_check`, `subagent_wait`, and `subagent_cancel`. Those five are the whole tool set. Subagents are not a Pi core feature: the Module owns its Profiles, queuing, child-process execution, cancellation, Limits, and the Background Protocol. Tool results are plain text plus the Job snapshot.

Vocabulary follows the glossary in `CONTEXT.md`. A Profile is a named child configuration (tools, model, prompt, Limits). A Job is one spawned child Pi process running under a Profile, tracked from queued through terminal state. Limits are the three watchdogs every Job runs under. The Background Protocol is the versioned snapshot stream a Job publishes for the UI Entry, plus the control channel for cancellation.

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

Each Profile lives in its own directory under [`profiles/`](./profiles/) holding its declaration (`index.ts`) and `prompt.md`. `profiles/profile.ts` supplies the default Limits and the child argument list, and `profiles/index.ts` lists what gets registered.

The worker reads repository guidance itself, completes the delegated task, edits files, runs focused validation, and returns a concise handoff. Its vendored Ponytail guidance favors existing code, the standard library, native platform features, installed dependencies, and the smallest correct diff while preserving validation, error handling, security, and accessibility. The upstream license is preserved in [`profiles/worker/prompt.LICENSE`](profiles/worker/prompt.LICENSE).

Both Profiles disable child sessions, extensions, skills, prompt templates, and automatic context-file loading. The worker prompt tells the child to discover `AGENTS.md` and contribution documentation before editing. No project-local or user-defined Profiles are loaded, and the child cannot recursively load this Extension.

Relative working directories resolve from the parent session's working directory. `~`, `~/...`, and the accidental leading `@` commonly produced by models are normalized before the directory is canonicalized.

## Jobs

`explorer` and `worker` validate the prompt and working directory, then return a Job id while the child waits on the process-wide FIFO concurrency limit. Continue useful parent work after spawning. Use `subagent_check` for non-blocking inspection, `subagent_wait` only when progress depends on results, and `subagent_cancel` for explicit cancellation. Aborting a wait never cancels its Jobs.

When a Job finishes and no `subagent_wait` is holding it, the Extension sends one `subagent-result` custom message through `pi.sendMessage` with `deliverAs: "followUp"` and `triggerTurn: true`. Pi owns the scheduling from there. If the agent is idle the message starts a turn; if a turn is running the message queues behind it. The Extension keeps no deferred results and does not watch `agent_settled` or track whether the agent is busy. A Job consumed by `subagent_wait` sends no follow-up, and a wait that starts after the follow-up went out returns nothing for that Job. Wait and follow-up output have smaller budgets within Pi's 50KB/2000-line hard ceiling; when the text is truncated the message ends with `Full output: <path>` pointing at the retained private file.

Jobs are the concurrency unit. Extra Jobs stay visibly queued and can be cancelled before they spawn. Cancellation and each of the three Limits are separate terminal statuses.

Reload, session replacement, fork, and quit abort all queued and running Jobs. Shutdown waits for settlement with a bounded teardown, removes full-output directories created by this Extension, emits `reset`, and never sends a late result message or writes a late spill. A Job that settles during shutdown is marked consumed and dropped. Jobs are not restored or reattached.

## Job state

Every Job carries one `SubagentJobV1`, defined in [`job-state.ts`](./job-state.ts): status, phase, timestamps, at most 64 active child tools, at most 20 recent activity entries, aggregate usage, an output preview, an error, and the retained full-output path. The manager republishes the complete Job state on every transition, never a delta, and the Background Protocol validates it before the UI renders anything. Job state contains no raw child transcript or unbounded stdout/stderr.

`job-state.ts` exports the constructors and the structural validator: `createInitialSubagentJob`, `updateSubagentJob`, `createTerminalSubagentJob`, `appendSubagentActivity`, and `isSubagentJobV1`. [`runner.ts`](./runner.ts) folds the child's event stream into that state and returns a `RunSubagentResult` whose `job` is always terminal.

## Background Protocol

The Extension emits complete version 1 snapshots on `pui.subagent.background` through `pi.events`. [`background-protocol.ts`](./background-protocol.ts) owns the wire format. Envelopes use schema `pi.subagent.background`, carry the current `sessionId` and a fresh Extension `instanceId`, and have a `type` of `ready`, `reset`, `upsert`, or `remove`. An `upsert` or `remove` carries one `job`: bounded id, title, prompt, and the Job state.

Version 1 serialises the Job state under the wire key `run`. That key is frozen with the schema version, so ticket 09 renamed the TypeScript binding without touching the wire: in process the field is `BackgroundSubagentJobV1.state`, and only `encodeBackgroundSubagentJob` and `parseBackgroundSubagentEvent` map between `state` and `run`. A consumer that reads the raw event sees `job.run`; a consumer that goes through the parser sees `job.state`.

At most 64 Jobs are tracked, pruning the oldest terminal entries first. The UI may cancel a Job with a bounded version 1 `pi.subagent.background.control` message on `pui.subagent.background.control`. The Extension accepts a control only when both session and instance match, and it removes the listener during shutdown.

The UI Entry, [`interfaces/ui.ts`](./interfaces/ui.ts), is the only way UI code reaches this Module. It exports the parser and reducer from [`background-bridge.ts`](./background-bridge.ts), which bound every string for rendering and keep at most 64 Jobs, plus `BackgroundSubagentBridge`, which owns event subscription, instance authority, and cancellation routing. [`instance-scoped-jobs.ts`](./instance-scoped-jobs.ts) is the copy-on-write reducer behind it: a `ready` from a new instance replaces the Job set, a `reset` empties it and lets the next instance take over, and events from any other instance are ignored.

## Security boundary

> **Worker Jobs are write-capable and not sandboxed.** They can edit files and execute arbitrary shell commands. The child inherits the parent process environment, `cwd` is only its starting directory, and process isolation does not confine filesystem or operating-system access. Use write-capable delegation only in trusted repositories.

The explorer's Pi tool allowlist is read-only, but it is likewise not an operating-system sandbox and does not confine reads to `cwd` or scrub the inherited environment.

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
| Activity history | 20 entries | Bounds published progress metadata |
| Model-visible output | 50 KB or 2000 lines | Pi's normal tool-output limits |

A call's non-empty `model` value always overrides model selection. Otherwise the Profile consults `PI_WORKER_MODEL` or `PI_EXPLORER_MODEL`, then uses its default.

If final output exceeds the model-visible limit, the Extension writes the complete assistant output to a mode-`0600` file in a private temporary directory and includes its path in the result. The file stays available during the active session and is removed at session shutdown. Paths supplied by the child runner remain externally owned and are not removed. No file is created for untruncated output.

## Troubleshooting

- `Unable to start child Pi`: ensure `pi` is on `PATH`. When the parent is Pi's CLI, the Extension reuses that CLI entrypoint; SDK hosts do not reuse their own `argv[1]`.
- Exited without a final assistant response: inspect the bounded stderr and diagnostic in the failed tool result. Malformed JSONL lines are reported as diagnostics rather than crashing the parent.
- Timed out, stalled, or tool stalled: the error names the Limit that fired. Narrow the delegated prompt, or change that Limit in the Profile's `profiles/<name>/index.ts` after review.
- Calls remain queued: inspect `PI_SUBAGENT_MAX_CONCURRENCY`; invalid values fall back to four.
- Full output path missing after truncation: the result remains usable, but the private temporary file could not be created.

## Verification

From the repository root:

```bash
bun run check
```

For a focused Module pass, use `bun test src/modules/subagents`. Tests use `fixtures/fake-child.mjs` and do not call a model or the network.
