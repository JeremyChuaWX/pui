# 08 — Shrink the App layer

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The App layer at `app/` holds only entry points and pui process management: the TUI entry (CLI parsing, process start, invoking the UI's start function) and the headless workflow entry (Pi Core plus the workflows Host Entry, importing no UI code). The old source directory is empty and deleted; the compiled binary behaves identically to before the refactor.

**Blocked by:** 05, 06, 07.

**Status:** ready-for-agent

- [ ] `app/` contains only the two entry points and process management; no UI logic
- [ ] Headless `pui workflow` runs without loading any UI code
- [ ] The old source directory no longer exists; build script and test globs updated
- [ ] Compiled binary starts, renders, and runs workflows as before
- [ ] `bun run check` is green
