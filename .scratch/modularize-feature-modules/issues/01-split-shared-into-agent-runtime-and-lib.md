# 01 — Split shared into agent-runtime and lib

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The two Shared Primitives exist as `shared/agent-runtime/` (Child-Agent Runtime: child Pi spawning, NDJSON streaming, the process-wide semaphore, Agent Roles and their guidance assets) and `shared/lib/` (validation, bounded process, retained output, JSON events, semaphore, background channel). Every consumer imports from the new homes; the old shared extension directory is gone. ADR 0001 records why Agent Roles belong to the Child-Agent Runtime.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `shared/agent-runtime/` and `shared/lib/` contain the split as specified; no old shared directory remains
- [ ] Agent Role guidance markdown travels with the Child-Agent Runtime
- [ ] ADR 0001 ("Agent Roles belong to the Child-Agent Runtime") exists under the ADR directory
- [ ] `bun run check` is green
