# 04 — Move subagents into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The subagents feature is a Module at `modules/subagents/` behind `interfaces/{pi,host,ui}.ts`. The host-side subagent view model and background subagent bridge move behind its UI Entry, so the UI consumes parsed subagent state from the Module instead of host-side bridge files. The Extension keeps its `pi -e` default export. Module tests move with the Module.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** done (commit 74cb733 on `modularize-feature-modules`)

- [x] `modules/subagents/interfaces/{pi,host,ui}.ts` are the only files imported from outside the Module (the Module's own tests still reach `extensions/test-support/`; flagged for the issue-09 boundary checker. `host.ts` is a reserved stub — subagents has no host-side needs today. The generic `instance-scoped-runs` reducer moved to `shared/lib/` so the workflow bridge keeps sharing it without a Module edge)
- [x] Subagent view model and background bridge live behind the UI Entry (`view-model.ts` + `background-bridge.ts`, exported via `interfaces/ui.ts`); no host-side subagent bridge files remain (`src/subagent.ts` and `src/background-subagent.ts` are gone; the mixed presentation test moved to `src/ui/subagent-view.test.ts` and consumes the UI Entry)
- [x] Foreground and background subagent runs behave as before in the TUI (all 51 module tests plus controller background-lifecycle and format tests pass unchanged)
- [x] Standalone loading via `pi -e` still works (verified by loading `interfaces/pi.ts` through `DefaultResourceLoader` in `src/bundled-extensions.test.ts`; all six subagent tools register with no errors)
- [x] `bun run check` is green
