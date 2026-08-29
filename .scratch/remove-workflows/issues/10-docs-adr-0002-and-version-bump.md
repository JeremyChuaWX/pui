# 10 — Docs, ADR 0002, version 0.9.0

**Parent:** issues/0002-remove-workflows.md

**What to build:** Every document describes the codebase as it now is. ARCHITECTURE, README, and CONTRIBUTION are rewritten for three Modules, the Interfaces Directory as `pi` plus `ui`, and a subagents Module that owns Profiles and the child runner. ADR 0002 records that subagents owns the child-agent runtime and marks ADR 0001 as superseded. The package version is 0.9.0.

**Blocked by:** 02 — Headless `--smoke` entry; 03 — Retire the Host Entry; 07 — Three-part Limits watchdog; 08 — Deliver results through Pi's `followUp`; 09 — Job vocabulary in the Background Protocol.

**Status:** done

- [x] ARCHITECTURE's diagram, layer descriptions, Module tables, and shared-primitive list match the tree with no Child-Agent Runtime, Host Entry, or workflows
- [x] README documents the five subagent tools, the two Profiles with their tools, models, env overrides, and Limits, the `--smoke` flag, and nothing about workflows
- [x] CONTRIBUTION's import example uses a surviving Module
- [x] ADR 0002 exists, states the trade-off (one consumer means a shared layer is indirection without reuse), and ADR 0001 is marked superseded by it
- [x] `package.json` version is 0.9.0
- [ ] issues/0002 status is set to done with the merge commit
- [x] `bun run check` is green
