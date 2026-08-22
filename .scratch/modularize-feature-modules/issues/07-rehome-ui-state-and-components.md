# 07 — Re-home the UI: state and components layers

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** The UI lives at `ui/` in two layers: `ui/state/` (the Controller and its collaborators — display-item formatting, shared view types, tool-execution tracking, dialog/toast queues) and `ui/components/` (the Solid shell and views). Views consume Module UI Entries instead of feature protocol files. The UI exports a single start function that owns renderer creation and mounting. UI imports only Pi Core, Module UI Entries, shared, and the Pi SDK.

**Blocked by:** 02, 04, 05, 06.

**Status:** ready-for-agent

- [ ] Controller and collaborators live in `ui/state/`; Solid shell and views in `ui/components/`
- [ ] No view or state file imports a Module except through `interfaces/ui.ts`
- [ ] The UI exposes exactly one start function owning renderer creation
- [ ] TUI renders and behaves as before (transcript, menus, dialogs, sidebar, workflow page)
- [ ] `bun run check` is green
