# 03 — Move web into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The web feature is a Module at `modules/web/` behind its Interfaces Directory: `pi.ts` (the Extension, with its `pi -e` default export). The Module stays self-contained, depending only on shared.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** done (commit 20d9ede on `modularize-feature-modules`)

- [x] `modules/web/interfaces/pi.ts` is the only file imported from outside the Module (the Module's own tests still reach `extensions/test-support/`; flagged for the issue-09 boundary checker)
- [x] Web search/crawl tools register and behave as before (all 32 module tests pass unchanged)
- [x] Standalone loading via `pi -e` still works (verified by loading `interfaces/pi.ts` through `DefaultResourceLoader`; `web_search`/`web_crawl` register with no errors)
- [x] `bun run check` is green
