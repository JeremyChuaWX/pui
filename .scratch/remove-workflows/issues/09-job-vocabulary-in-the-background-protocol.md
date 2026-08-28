# 09 — Job vocabulary in the Background Protocol

**Parent:** issues/0002-remove-workflows.md

**What to build:** The Background Protocol, bridge, view models, and UI helpers call a spawned child a Job everywhere. `SubagentRunV1` becomes `SubagentJobV1`, and "run" is no longer used for the instance in type names, field names, event names, or documentation. Bounds, instance authority, cancellation control matching, and the 64-Job pruning are unchanged.

**Blocked by:** 06 — Remove the blocking `subagent` tool and the tool-details protocol.

**Status:** ready-for-agent

- [ ] No exported subagents type, field, or event uses "run" for a Job; `SubagentJobV1` is the Job type in the Background Protocol
- [ ] The instance-scoped helper and bridge use Job naming
- [ ] Protocol, bridge, and UI helper tests pass with the new names; envelope schema and version are unchanged
- [ ] The subagents README uses Profile, Job, Limits, and Background Protocol as defined in CONTEXT.md
- [ ] `bun run check` is green
