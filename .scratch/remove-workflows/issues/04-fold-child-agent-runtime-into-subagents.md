# 04 — Fold the Child-Agent Runtime and single-consumer shared files into subagents

**Parent:** issues/0002-remove-workflows.md

**What to build:** A mechanical move with no behaviour change. The subagents Module owns the child-agent runner, Profile definitions and prompt assets (including the Ponytail license), the semaphore, instance-scoped runs, the background channel, and the JSONL event parser. The shared library keeps only retained output, bounded process, and validation. This is the prefactor for tickets 05 through 09.

**Blocked by:** 01 — Delete the workflows Module and everything that only served it.

**Status:** ready-for-agent

- [ ] `src/shared/agent-runtime` no longer exists; its code, prompt assets, fixtures, and tests live inside the subagents Module
- [ ] Semaphore, instance-scoped runs, background channel, and JSON events live inside the subagents Module with their tests
- [ ] The shared library contains only files with two or more consuming Modules (retained output, bounded process, validation)
- [ ] Exports that had no consumer after the workflows deletion (`agentPreset`, `RESOLVED_AGENT_NAMES`, unused usage/phase/tool type re-exports) are removed
- [ ] The boundary checker still passes and the Register File test's asset checks point at the new locations
- [ ] ADR 0001 is untouched here (superseded in ticket 10)
- [ ] `bun run check` is green with existing tests moved, not rewritten
