---
id: 0003
title: Fix background subagent result delivery and observability
status: done
labels: [ready-for-agent, bug]
created: 2026-08-29
---

# Fix background subagent result delivery and observability

## Resolution

Resolved by ADR 0003's alignment with the local Pi subagent Extension. Results now use `steer`,
which reaches the parent before its next model call. The blocking `subagent_wait` and its
`terminalConsumed` ownership state were removed; `subagent_list` is an immediate active-Job
snapshot and completion always arrives as one retained `subagent-result` message. The in-process
child `AgentSession` runtime also replaces the old process event-folding stack. pui keeps only a
small active-Job bridge for sidebar observation; cancellation remains a model tool.

The observability enhancements proposed below are not part of the simplified design. They remain
historical investigation notes rather than current acceptance criteria.

## Problem statement

A background subagent Job can reach a terminal state while its result remains invisible to the
parent model for minutes. A later `subagent_wait` can then return an empty result even though the
Job succeeded. In a smaller failure window, the manager can discard the only retrievable copy of
the result after a delivery error.

This is a pui delivery bug. It is separate from child liveness. The Luna worker reviewed during
this investigation was still running, but the completed Luna and Sol explorer Jobs both exhibited
the delivery problem.

There are two cases to distinguish:

1. The usual case is delayed delivery. The result is queued in Pi and should arrive after the
   parent stops calling tools.
2. The failure case is lost delivery. The manager marks the result consumed before it knows that
   Pi accepted or displayed it, and it has no retry or acknowledgement path.

The UI makes both cases look like a hung child because it does not show result-delivery state,
queued completion messages, current activity, or a useful heartbeat while `subagent_wait` blocks.

## Evidence from real sessions

The review compared these sessions:

- Luna: `2026-08-29T15-51-08-050Z_01a04e37-b212-7314-869c-6cd5b02a3441.jsonl`
- Sol: `2026-08-29T15-59-06-826Z_01a04e3f-004a-772e-8f58-ce37b802a778.jsonl`

### Luna

The `test-layout` explorer Job completed at `15:52:30.696` UTC. The parent checked it at
`15:53:20` and saw `succeeded`, then called `subagent_wait`, which returned `results: []`. The
queued `subagent-result` custom message did not reach the parent until `15:58:11`, roughly five
minutes and forty-one seconds after completion.

The later `move-tests` worker was not an example of a lost completion. At the last check it had
run for about two minutes, completed 10 turns and used 95.7k tokens, and had produced an event
less than five seconds earlier. It was active but inefficient. The opaque wait made it look hung.

### Sol

The first `test-layout` explorer Job completed at `16:00:27.549`. A `subagent_wait` began about
31 milliseconds later and returned `results: []`. A check three seconds later reported
`succeeded`. The queued result did not enter the transcript until `16:09:40`, after the parent had
finished the refactor and written its final answer. That late result caused another parent turn.

The same investigation reproduced the behavior again: both review Jobs completed before their
results appeared as later messages in the main session.

## Current code path

### Completion is queued behind the whole parent run

`src/modules/subagents/interfaces/pi.ts` sends an unwaited terminal result with:

```ts
{ deliverAs: "followUp", triggerTurn: true }
```

Pi documents `followUp` as delivery only after the agent has no more tool calls. A parent that
keeps reading files, running commands, or polling Jobs can therefore delay a completed child
result for the rest of its run. `triggerTurn` only helps when the parent is idle.

This is why the result eventually appeared in the Luna and Sol sessions. It was complete and
queued, but unavailable to the parent model that needed it.

### The manager treats queueing as consumption

`BackgroundSubagentManager.consumeAndDeliver()` in
`src/modules/subagents/background-manager.ts` does this in order:

```ts
job.terminalConsumed = true;
this.options.deliver(...);
```

`subagent_wait` filters out every Job whose `terminalConsumed` flag is true. Once automatic
delivery has been attempted, a wait cannot retrieve that result even if Pi has only queued it and
the parent has not seen it. The returned presentation is an unexplained empty string with
`results: []`.

One boolean currently means several different things:

- a wait returned the result
- automatic delivery was attempted
- Pi queued the result
- the parent model received the result
- the result may be pruned

Those states are not equivalent.

### Delivery failure permanently consumes the result

`consumeAndDeliver()` catches and discards delivery exceptions after setting
`terminalConsumed`. It does not restore availability, record an error, or retry. The existing
manager test named `keeps settlement successful when host delivery throws` codifies the loss: it
expects one failed attempt and expects a later wait to return `[]`.

Pi's Extension API does not return a delivery acknowledgement from `sendMessage`. Its public call
returns `void`, and Pi handles asynchronous errors inside its runtime. The manager therefore
cannot infer delivery from a successful function return. It only knows that it requested
delivery.

### The queued result is hard to observe

The Module publishes Job status, phase, active tools, recent activity, timestamps, usage, output
preview, error, and retained-output path through the Background Protocol. It does not publish the
result's delivery state.

The pui sidebar exposes only a small portion of the available Job data. The management menu does
not provide a live inspector, and selecting an active Job is a cancellation action. The wait tool
also ignores its `onUpdate` callback, so a blocking wait shows no live heartbeat.

Pi's custom-message path queues the result directly on the agent's follow-up queue. It does not
populate the ordinary string list returned by `getFollowUpMessages()`, which pui renders as queued
follow-ups. A queued subagent result is therefore absent from that display too.

### Shutdown deliberately drops results

A Job settling during manager shutdown is marked consumed but is not delivered. Session-scoped
Jobs are intentionally not restored or reattached, so cancelling active work at shutdown is
expected. A result that completed before shutdown but remains queued in the old Pi session is
also not tracked separately and can disappear with that session.

Cross-session Job persistence is not required by this issue. The same-session state must still be
honest: queued is not delivered, and a failed delivery must remain recoverable until shutdown.

## Why the tests pass

The focused suite passes:

```text
35 pass
0 fail
```

The tests verify the current contract rather than the user-visible requirement. In particular,
they assert that:

- automatic delivery uses `followUp`
- a later wait finds nothing after automatic delivery was attempted
- a synchronous delivery exception leaves the Job successful and unavailable to later waits

The SDK integration test proves that a queued follow-up is eventually persisted after the parent
settles. It does not cover a long-running parent that keeps issuing tool calls, the interval
between queueing and model delivery, or recovery after a delivery failure.

## Resolution

### Track result delivery explicitly

Replace `terminalConsumed` with a result state owned by the subagents Module. The exact names may
change, but the state must distinguish at least:

- `available`: terminal result exists and no consumer owns it
- `waiting`: one or more active waits own settlement
- `queued`: the Extension asked Pi to inject the result
- `delivered`: the result entered the parent transcript
- `wait_consumed`: a wait returned the result
- `delivery_failed`: injection failed and the result remains recoverable

Store queue time, delivery time, attempt count, and the last delivery error where applicable.
Pruning may remove only `delivered` and `wait_consumed` Jobs. It must not remove `available`,
`queued`, or `delivery_failed` results.

The Extension can acknowledge delivery by listening for `message_end` on the
`subagent-result` custom message and matching its Job id. A successful call to `sendMessage` means
queued, not delivered.

### Deliver at the next safe parent boundary

Use `deliverAs: "steer"` for automatic completion messages. Pi delivers steering messages after
the current assistant response finishes its tool calls and before the next model call. This lets
the parent use a completed Job without waiting for the entire multi-turn tool run to end.

An active `subagent_wait` at settlement still owns the result and suppresses automatic injection.
If a wait begins after injection has already been queued, it must return an explicit queued state,
not `results: []`. The Job id provides deduplication if an unavoidable queue race exposes the same
completion through both paths.

A failed injection must leave the terminal result available to `subagent_wait` and
`subagent_check`. The Extension should retry at a safe lifecycle point or report
`delivery_failed`; it must not silently discard the result.

### Make waits observable

Pass the tool's `onUpdate` callback into the manager while `subagent_wait` is active. Throttled
updates should show, for each requested Job:

```text
move-tests · running/thinking · 1m59s
Last event 5s ago · 10 turns · 95.7k tokens
Latest: grep import.meta.url usages
```

When the Job is terminal but awaiting parent injection, show `completed · result queued` with the
queue age. Aborting a wait must say that the Job continues running.

### Add a Job inspector

`/subagents` should open a live detail view instead of treating selection as cancellation. Show:

- phase, current tools, and current-tool age
- last event age and recent timestamped activity
- elapsed time, turns, tokens, and cost
- output preview and retained-output path
- result delivery state and queue age
- explicit Cancel and Cancel All actions with confirmation

The sidebar should show at least the current phase or tool and the last event age. Keep recent
terminal Jobs visible long enough to inspect completion and delivery.

### Add productivity warnings separately from liveness Limits

The existing wall-clock, stall, and tool-stall Limits correctly detect silence. Lowering them
would not have caught the Luna worker because it kept producing events. Add warnings or optional
budgets for excessive turns, tokens, cost, and time without a direct edit. These are productivity
signals, not replacements for the three liveness Limits.

## User stories

1. As the parent model, I want a completed Job result before my next model call, so that I can use
   it while work is still in progress.
2. As a pui user, I want to see whether a terminal result is available, queued, delivered, or
   failed, so that `succeeded` never hides the delivery state.
3. As the parent model, I want `subagent_wait` to return a result or an explicit disposition, so
   that it never produces an unexplained empty response.
4. As a pui user, I want a live heartbeat during a blocking wait, so that I can distinguish a
   healthy child from a silent one.
5. As a pui user, I want inspection and cancellation to be separate actions, so that checking a
   Job cannot stop it accidentally.
6. As a pui maintainer, I want failed result injection to remain recoverable and tested, so that a
   host error cannot erase the only copy.

## Acceptance criteria

- A Job that finishes while the parent keeps calling tools reaches the parent before the next LLM
  call rather than after the entire agent run.
- `subagent_wait` never returns blank content for a known requested Job. It returns a terminal
  result or an explicit state explaining where that result is.
- A delivery exception does not make the result unavailable. A later wait can retrieve it.
- `subagent_check` reports terminal result disposition and enough bounded output to recover from a
  failed or queued delivery.
- The Background Protocol exposes bounded result-delivery state. The UI renders it.
- A blocking wait streams throttled Job snapshots without cancelling the child when the wait is
  aborted.
- `/subagents` inspects by default. Cancellation is explicit and confirmed.
- Normal completion produces one model-usable result identified by Job id. Queue races are
  deduplicated or clearly identified.
- Session shutdown still cancels active Jobs and leaves no child process behind.
- `bun run check` passes.

## Testing decisions

Update the manager, Extension, SDK, Controller, and UI tests at their existing seams.

Add coverage for:

- terminal state followed by `queued`, then `delivered` on matching custom-message `message_end`
- a parent that continues with more tool calls after child completion and receives the steering
  result before its next model call
- a wait active before settlement consuming the result without automatic injection
- a wait beginning after queueing returning an explicit queued disposition instead of `[]`
- a synchronous delivery throw retaining the result for a later wait
- a queued delivery that never receives acknowledgement remaining inspectable and unprunable
- a failed delivery retry or recovery path
- wait `onUpdate` output for running, active-tool, terminal-queued, and failed-delivery states
- inspect and cancel as separate menu actions
- sidebar rendering of last-event age and delivery state
- shutdown during running work, terminal spill, queued delivery, and acknowledged delivery

Use injected clocks and fake Pi/child collaborators. Do not use real sleeps or network models.

## Out of scope

- Persisting or reattaching child processes across session replacement or application restart
- Changing explorer or worker model defaults
- Replacing the three existing liveness Limits
- Inferring semantic progress from arbitrary child text

## Immediate workaround

Until this is fixed, aborting `subagent_wait` does not cancel the Job. The parent can call
`subagent_check` and report phase, active tools, last activity age, and usage. If the Job is active
but unproductive, use `subagent_cancel`. If it is terminal and wait returns empty, the result may
already be queued as a delayed follow-up; keep the session alive long enough for the parent run to
settle.
