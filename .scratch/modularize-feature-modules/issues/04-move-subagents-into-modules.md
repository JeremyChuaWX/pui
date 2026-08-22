# 04 — Move subagents into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The subagents feature is a Module at `modules/subagents/` behind `interfaces/{pi,host,ui}.ts`. The host-side subagent view model and background subagent bridge move behind its UI Entry, so the UI consumes parsed subagent state from the Module instead of host-side bridge files. The Extension keeps its `pi -e` default export. Module tests move with the Module.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** ready-for-agent

- [ ] `modules/subagents/interfaces/{pi,host,ui}.ts` are the only files imported from outside the Module
- [ ] Subagent view model and background bridge live behind the UI Entry; no host-side subagent bridge files remain
- [ ] Foreground and background subagent runs behave as before in the TUI
- [ ] Standalone loading via `pi -e` still works
- [ ] `bun run check` is green
