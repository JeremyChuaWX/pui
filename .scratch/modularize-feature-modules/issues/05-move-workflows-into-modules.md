# 05 — Move workflows into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The workflows feature is a Module at `modules/workflows/` behind all four entries: `pi.ts` (Extension with `pi -e` default export), `host.ts` (Host Entry for the headless run path), `ui.ts` (UI Entry absorbing the workflow bridge and the workflow-specific portions of the shared formatters/types), and `api.ts` (the authoring SDK). The `"pui/workflow"` package export repoints at `api.ts` — the specifier workflow scripts import is unchanged.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** ready-for-agent

- [ ] `modules/workflows/interfaces/{pi,host,ui,api}.ts` are the only files imported from outside the Module
- [ ] Workflow bridge and workflow-specific formatter/type logic live behind the UI Entry
- [ ] Existing `.pui/` workflow scripts run unchanged via the `"pui/workflow"` specifier
- [ ] Standalone loading via `pi -e` still works
- [ ] `bun run check` is green
