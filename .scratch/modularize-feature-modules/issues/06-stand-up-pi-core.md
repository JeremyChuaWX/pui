# 06 — Stand up pi-core/

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** Pi Core exists at `pi-core/` and owns all registration: the Register File (single composition root listing every Module's Extension), skill bundling with the embedded skills data moved under Pi Core, and AGENTS.md/guidance handling. Pi Core imports only Module `pi.ts` entries and shared — never a Host Entry or UI Entry.

**Blocked by:** 02, 03, 04, 05 — all Module moves.

**Status:** done (commits a11bfe3 on `modularize-feature-modules`)

- [x] Register File in `pi-core/` composes the four Extensions; tool registration behaves as before
- [x] Embedded skills data lives under Pi Core and is bundled into the binary as before
- [x] Pi Core imports nothing from Modules except `interfaces/pi.ts`
- [x] `bun run check` is green
