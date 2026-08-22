# 09 — Boundary-check script in the check gate

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** A boundary-check script enforces the one-way edge list: App → UI start + Pi Core + Host Entries; UI → Pi Core + UI Entries + shared + Pi SDK; Pi Core → Extensions + shared; Modules → shared + Pi SDK; shared importable by all; outside a Module only its Interfaces Directory is importable. It is a function from an import graph to a violation list, with fixture tests per forbidden edge, and runs against the real repo inside the standard check gate.

**Blocked by:** 08 — Shrink the App layer.

**Status:** done (commit 8915e83 on `modularize-feature-modules`)

- [x] Fixture tests cover each forbidden edge: Module→Module, UI→App, Pi Core→Host Entry, deep import bypassing an Interfaces Directory, plus a clean graph
- [x] The script runs in `bun run check` and passes against the real repo
- [x] Introducing a violating import makes `bun run check` fail with a message naming the offending edge
- [x] `bun run check` is green
