# 08 — Deliver results through Pi's `followUp`

**Parent:** issues/0002-remove-workflows.md

**What to build:** When a Job finishes and no `subagent_wait` consumed it, the Extension sends one `subagent-result` message with `deliverAs: "followUp"` and `triggerTurn: true`. Pi starts a turn if the agent is idle and queues the message behind the current turn if busy. The hand-rolled deferred-result map and the `agent_settled` hook are removed. Truncated results keep the path to the retained full output.

**Blocked by:** 04 — Fold the Child-Agent Runtime and single-consumer shared files into subagents.

**Status:** ready-for-agent

- [ ] A finished, unconsumed Job produces exactly one `subagent-result` message using `followUp` delivery with `triggerTurn`
- [ ] A Job consumed by `subagent_wait` produces no follow-up message
- [ ] The deferred-result map, the idle check, and the `agent_settled` handler are removed from the manager and Extension
- [ ] Shutdown, reload, fork, and session switch send no late result messages
- [ ] Truncated results include the retained full-output path; retained files are removed at shutdown as before
- [ ] Extension-seam tests assert on the sent messages rather than on internal state
- [ ] `bun run check` is green
