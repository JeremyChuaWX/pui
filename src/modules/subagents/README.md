# Subagents Module

This Module follows the subagent Extension in the user's local Pi setup. It registers four tools:
`explorer`, `worker`, `subagent_cancel`, and `subagent_list`. Each Profile tool starts an isolated,
in-process child `AgentSession` and returns a Job id immediately. Completion is injected into the
parent with a `subagent-result` steer message.

The only pui-specific addition is the UI Entry: active-Job snapshots are published on
`pi.subagents.jobs` for the sidebar.

## Profiles and tool shape

Both Profile tools accept:

```ts
{
  task: string;
  cwd?: string; // defaults to the parent working directory
}
```

| Profile | Tools | Model | Thinking | Prompt |
| --- | --- | --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls` | `openrouter/z-ai/glm-5.3-flash` | low | replaces the system prompt |
| `worker` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | `openrouter/z-ai/glm-5.3-flash` | high | appends coding guidance |

The child disables extensions, skills, prompt templates, themes, context files, and session
persistence. The explorer is read-only at the Pi tool boundary. The worker is write-capable and is
not sandboxed.

`subagent_cancel` accepts one to 64 Job ids. `subagent_list` returns the current queued and running
Jobs without waiting and terminates the parent turn. Profile guidance explicitly tells the model
not to poll: after dispatch it should continue only independent useful work, otherwise end its turn
so a completion can arrive.

## Runtime

`subagent.ts` builds one isolated child `AgentSession` per Job with `createAgentSession`. This avoids
the prior child-process CLI, JSONL parser, process semaphore, event-folding state machine, and
SIGTERM/SIGKILL machinery. The runner subscribes only to liveness events, prompts once, collects
the final assistant text and aggregate usage, and always disposes the child session.

`manager.ts` is the single Job owner. It provides:

- Profile-scoped ids such as `explorer_1` and `worker_1`;
- FIFO queueing with four active Jobs by default and 16 additional queued Jobs;
- cancellation through `AbortController`;
- a 10-minute inactivity Limit reset by child activity;
- a 60-minute whole-Job hard Limit;
- one terminal result-delivery path.

Set `PI_SUBAGENT_MAX_ACTIVE` to change active concurrency; values are clamped to 1 through 64.
Cancelled Jobs produce no completion message. Reload, session replacement, fork, and quit shut down
the session's Manager and cancel its remaining Jobs.

## Result delivery

`result-message.ts` writes every complete result to:

```text
<temp>/pi-subagents/<session-id>/<job-id>.md
```

If that path already exists after a reload, the writer adds a numeric suffix instead of overwriting
it. The custom message keeps at most 16 KiB of result preview inline and records structured details
for rendering. The
Extension sends it with:

```ts
{ deliverAs: "steer", triggerTurn: true }
```

A steer reaches the parent after the current assistant response's tools and before its next model
call. This removes the old `subagent_wait` ownership race and the delayed `followUp` delivery path.
Pi's TUI receives the same collapsible message renderer as the local Extension; pui renders the
custom message through its OpenTUI transcript.

## UI Entry

`protocol.ts` owns the small in-process event shape:

```ts
{ sessionId: string, jobs: Job[] }
```

Only active Jobs are published. `background-bridge.ts` validates and bounds every string and
replaces the Controller's complete active set for the matching session. There is no versioned wire
envelope, instance authority reducer, terminal history, control channel, or duplicated Job state
model.

## Files

- `interfaces/pi.ts` — Extension registration and session wiring
- `manager.ts` — queue, Limits, cancellation, and delivery
- `subagent.ts` — isolated child `AgentSession` runner
- `protocol.ts` — Profile, Job, runner, result, and UI event types
- `result-message.ts` — retained output and Pi TUI renderer
- `profiles/` — explorer and worker declarations and prompts
- `background-bridge.ts`, `interfaces/ui.ts` — pui-specific UI observation seam

## Verification

```bash
bun test test/modules/subagents
bun run check
```
