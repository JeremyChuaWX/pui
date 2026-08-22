# 03 — Move web into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The web feature is a Module at `modules/web/` behind its Interfaces Directory: `pi.ts` (the Extension, with its `pi -e` default export). The Module stays self-contained, depending only on shared.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** ready-for-agent

- [ ] `modules/web/interfaces/pi.ts` is the only file imported from outside the Module
- [ ] Web search/crawl tools register and behave as before
- [ ] Standalone loading via `pi -e` still works
- [ ] `bun run check` is green
