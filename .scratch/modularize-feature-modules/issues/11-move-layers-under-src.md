# 11 — Move the layers under src/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The five layers (`app/`, `ui/`, `pi-core/`, `modules/`, `shared/`) move under `src/`, so the architecture is the whole `src/` listing instead of five directories mixed with configs, docs, and tooling at the repo root. The stale `extensions/` directory dissolves: its test helpers become `src/test-support/` and its ambient asset declarations `src/assets.d.ts`. `scripts/`, `docs/`, `issues/`, and `.pui/` stay at the root. Package scripts, the package export map, `tsconfig` includes, the build script, the boundary scanner's root, and every doc path follow. Behavior is unchanged; this reverses the "no `src/` wrapper" decision in issue 0001, which is amended.

**Blocked by:** 10 — Rewrite the architecture docs.

**Status:** done (commit 3887b4f on `modularize-feature-modules`)

- [x] `src/` lists exactly `app/`, `ui/`, `pi-core/`, `modules/`, `shared/`, `test-support/`, `assets.d.ts`; no `extensions/` at the root
- [x] `"pui/workflow"` still resolves (export map repointed at `src/modules/workflows/interfaces/api.ts`)
- [x] Boundary scanner is rooted at `src/`; the rule function and its fixtures are unchanged
- [x] README, `docs/ARCHITECTURE.md`, `CONTRIBUTION.md`, ADR 0001, issue 0001, and `.coderabbit.yaml` reference `src/…` paths; no references to old paths remain
- [x] `bun run check` is green
