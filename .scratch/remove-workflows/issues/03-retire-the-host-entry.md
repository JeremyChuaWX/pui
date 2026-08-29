# 03: Retire the Host Entry

**Parent:** issues/0002-remove-workflows.md

**What to build:** The Interfaces Directory is `pi` (required) plus `ui` (where the UI needs it). No Module has a `host` entry, the boundary checker has no App→Module edge, and the App layer imports only Pi Core and the UI start function.

**Blocked by:** 01: Delete the workflows Module and everything that only served it.

**Status:** done

- [x] The subagents Module's empty `host` entry is deleted; no other Module has one
- [x] The boundary checker rejects any import from the App layer into a Module; a fixture proves it
- [x] The boundary checker no longer maps the App layer to a `host` entry name
- [x] CONTRIBUTION and ARCHITECTURE describe the Interfaces Directory as `pi` and `ui` only
- [x] `bun run check` is green
