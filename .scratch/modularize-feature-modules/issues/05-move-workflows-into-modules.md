# 05 — Move workflows into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The workflows feature is a Module at `modules/workflows/` behind all four entries: `pi.ts` (Extension with `pi -e` default export), `host.ts` (Host Entry for the headless run path), `ui.ts` (UI Entry absorbing the workflow bridge and the workflow-specific portions of the shared formatters/types), and `api.ts` (the authoring SDK). The `"pui/workflow"` package export repoints at `api.ts` — the specifier workflow scripts import is unchanged.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** done (commit a82a7c3 on `modularize-feature-modules`)

- [x] `modules/workflows/interfaces/{pi,host,ui,api}.ts` are the only files imported from outside the Module (the Module's own tests still reach `extensions/test-support/`; flagged for the issue-09 boundary checker. `interfaces/host.ts` owns the headless run path — absorbed from `src/headless-workflow.ts` — and also exports the backend/manager/storage the compiled smoke harness in `src/workflow-smoke.ts` uses)
- [x] Workflow bridge and workflow-specific formatter/type logic live behind the UI Entry (`src/workflow-bridge.ts` became `bridge.ts`; `resolveWorkflowRun` moved from `src/format.ts` into `view-model.ts`; both exported via `interfaces/ui.ts` together with the `WorkflowRunSummaryV1`/status types the controller and views consume; the workflow half of `src/bridge-reducers.test.ts` moved to `bridge.test.ts`)
- [x] Existing `.pui/` workflow scripts run unchanged via the `"pui/workflow"` specifier (the package export repoints at `modules/workflows/interfaces/api.ts`; the specifier is untouched and the headless CLI test still runs real workflow files end to end)
- [x] Standalone loading via `pi -e` still works (`interfaces/pi.ts` keeps the default export with `createDefaultWorkflowDependencies` production wiring; registration is exercised by `interfaces/pi.test.ts` and the bundled-factory composition test in `src/bundled-extensions.test.ts`)
- [x] `bun run check` is green
