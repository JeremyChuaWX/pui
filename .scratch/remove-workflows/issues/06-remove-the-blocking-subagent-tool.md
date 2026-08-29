# 06: Remove the blocking `subagent` tool and the tool-details protocol

**Parent:** issues/0002-remove-workflows.md

**What to build:** The tool set is exactly `explorer`, `worker`, `subagent_check`, `subagent_wait`, `subagent_cancel`. The versioned `pi.subagent` tool-details snapshot protocol, the transcript live renderer for it, and the normalisation view model are deleted. The UI Entry exports only the Background Protocol parser, reducer, bridge, and the status helpers the sidebar and palette use. The sidebar and palette keep showing and cancelling Jobs.

**Blocked by:** 05: `explorer` and `worker` spawn tools with Profile directories.

**Status:** done

- [x] The blocking `subagent` tool, the `tool_result` details-retention hook, and the run-job / runner code that only served it are removed
- [x] The tool-details protocol, its transcript renderer, the subagent view helpers used only by that renderer, and their tests are deleted
- [x] The UI Entry no longer exports the normalisation view model or the active-tools constant; the formatter has no subagent tool-details branch
- [x] Active and recent Jobs still render in the sidebar with status, elapsed time, and title; cancel from the palette still works
- [x] Controller-seam tests assert snapshots carry background Jobs and that Jobs abort across new session, switch, fork, and dispose
- [x] The Register File test and the smoke build expect exactly the five tools
- [x] `bun run check` is green
