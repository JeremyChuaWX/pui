# 02 — Move file-search into modules/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The file-search feature is a Module at `modules/file-search/` whose only importable surface is its Interfaces Directory: `pi.ts` (the Extension, keeping its default export for standalone `pi -e` loading) and `ui.ts` (the UI Entry exposing the `@`-completion surface the Controller consumes). The Controller's deep import into file-search internals is replaced by the UI Entry. Everything else in the Module is private.

**Blocked by:** 01 — Split shared into agent-runtime and lib.

**Status:** done (commits 4622a98, 4da9533 on `modularize-feature-modules`)

- [x] `modules/file-search/interfaces/{pi,ui}.ts` are the only files imported from outside the Module (the Module's own tests still reach `extensions/test-support/`; flagged for the issue-09 boundary checker)
- [x] `@`-file completion in the TUI works exactly as before (`ui.ts` now owns the fd-command fallback via `fdCompletionCommand()`)
- [x] Standalone loading via `pi -e` still works (verified by loading `interfaces/pi.ts` through `DefaultResourceLoader`; `fd`/`rg` register with no errors)
- [x] `bun run check` is green
