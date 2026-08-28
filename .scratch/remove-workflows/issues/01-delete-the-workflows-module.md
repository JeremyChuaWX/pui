# 01 — Delete the workflows Module and everything that only served it

**Parent:** issues/0002-remove-workflows.md

**What to build:** pui builds, tests, and runs with no trace of workflows. The `workflow` subcommand and `--workflow-smoke` flag are gone from the CLI and its help text. `/workflow` and `/workflows` no longer exist. The workflow page, the Workflows sidebar section, the workflow palette entry and its run/phase/agent submenu tree, the workflow transcript renderer, and the workflow fields on display items, snapshots, and prompt actions are all removed. The Register File no longer lists `pui-workflow`. The package has no `./workflow` export (and no `exports` map at all). The confirm dialog cap is an honest bound on untrusted extension content. Local workflow state is deleted.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The workflows Module directory, the headless workflow entry, and the workflow smoke entry no longer exist
- [x] `pui --help` lists no workflow subcommand or flag; `pui workflow` is treated as an ordinary prompt argument
- [x] The Register File test expects exactly `pui-file-search`, `pui-subagent`, `pui-web` and their tools
- [x] No UI file imports from the workflows Module; snapshot, display item, and prompt action types carry no workflow fields; the sidebar, palette, transcript, and app shell have no workflow branches
- [x] Esc/Ctrl+C handling that only existed to leave the workflow page is removed; dialog dismissal keys still work
- [x] The confirm dialog message cap is 16 KiB with a comment describing it as a bound on extension content
- [x] The smoke build runs only the `--help` check (the `--smoke` entry is ticket 02)
- [x] Boundary checker test fixtures reference subagents and web paths, not workflows
- [x] `.pui/` and its gitignore line are deleted from the repo; `workflow-runs`, `workflow-worktrees`, and `workflow-approvals.json` are deleted from `~/.pi/agent`
- [x] README, ARCHITECTURE, and CONTRIBUTION contain no workflow sections or examples (a full rewrite for the new subagents shape waits for ticket 10)
- [x] `bun run check` is green
