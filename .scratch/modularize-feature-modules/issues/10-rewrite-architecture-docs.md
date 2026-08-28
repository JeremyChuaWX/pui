# 10 — Rewrite the architecture docs

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The architecture and contribution docs describe the new five-layer layout in the glossary vocabulary (Module, Extension, Pi Core, App, Controller, Register File, Shared Primitive, Child-Agent Runtime, Agent Role, Interfaces Directory, Host Entry, UI Entry): layer diagram, dependency edges, Interfaces Directory convention, and the boundary-check gate. The existing conventions (deep modules behind narrow interfaces, options-bag DI, protocol ownership) are restated against the new layout. Stale refactor-plan documents are removed.

**Blocked by:** 09 — Boundary-check script in the check gate.

**Status:** done (commit 326e35b on `modularize-feature-modules`)

- [x] Architecture doc reflects the new layout, edges, and entry conventions; no references to old paths remain
- [x] Agent-facing contribution docs point to the updated conventions
- [x] Superseded refactor-plan docs deleted (all pass-1–4 plan docs were already removed before this branch; verified none remain outside `issues/` and `.scratch/`)
- [x] `bun run check` is green
