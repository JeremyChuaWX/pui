# Align subagents with the local Pi Extension

Status: accepted.

pui previously implemented subagents as child Pi CLI processes with JSONL event folding, a
process-wide semaphore, three process watchdogs, a versioned per-Job Background Protocol, and
`subagent_check`/`subagent_wait` result ownership. The user's local Pi setup had converged on a much
smaller Extension: isolated in-process child `AgentSession`s, one Manager, two liveness Limits,
active-Job snapshots, and automatic steer delivery.

Maintaining two different implementations made fixes and prompt/tool changes expensive. The pui
implementation also had a known delivery flaw: `followUp` could hide a completed result until the
parent settled, while `terminalConsumed` made that result unavailable to `subagent_wait`.

The subagents Module now follows the local Extension's public and internal shape:

- `explorer` and `worker` accept `{ task, cwd? }`;
- `subagent_cancel` and non-blocking `subagent_list` are the only management tools;
- one in-process child `AgentSession` runs each Job with optional resources disabled;
- the Manager owns FIFO concurrency, cancellation, inactivity and hard Limits, and delivery;
- results are retained to disk and injected with `deliverAs: "steer"`;
- the Background Protocol publishes only the complete active-Job set for the current session.

pui keeps one deliberate adapter that the local Pi TUI does not need: `BackgroundSubagentBridge`
validates active snapshots for the OpenTUI sidebar. It does not introduce a second Job state model
or a control channel.

The trade-off is reduced child observability: pui no longer shows active tools, phases, rolling
usage, terminal history, or separate stall/tool-stall statuses. It also gives up operating-system
process isolation, which was never a security sandbox. The child still has an isolated model
context and an explicit tool allowlist. Worker Jobs remain write-capable and unsandboxed.

If richer progress is needed later, add it to the shared local-style Job/event contract rather than
reintroducing a pui-only child-process runtime or blocking result-consumption tools.
