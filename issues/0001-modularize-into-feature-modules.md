---
id: 0001
title: Modularize the codebase into feature Modules behind Interfaces Directories
status: open
labels: [ready-for-agent, refactor]
created: 2026-08-22
---

# Modularize the codebase into feature Modules behind Interfaces Directories

## Problem Statement

The codebase has grown four features (subagents, workflows, web, file search) whose
extension-side code is well isolated, but the host side reaches into feature
internals freely: the controller, formatters, bridges, and OpenTUI views deep-import
extension protocol files in roughly ten places. There is no enforced boundary, so
nothing stops the next change from adding another cross-cutting import. A
contributor (human or agent) cannot tell from the directory layout which code is a
feature, which code is Pi integration, and which code is the pui application — and
cannot trust that touching one feature won't ripple into the others.

## Solution

Reorganize the source under `src/` into five top-level layers — `app/`, `pi-core/`,
`modules/`, `shared/`, `ui/` — where each feature is a self-contained Module whose
only importable surface is its Interfaces Directory. The Pi model reaches features
through Extensions loaded by Pi Core's Register File; the UI reaches features
through each Module's UI Entry; the App layer reaches features through Host
Entries. All dependency edges are one-way and machine-enforced by a boundary-check
script wired into the standard check gate. Behavior is unchanged: this is a
re-homing of existing code plus formalized entry points, not a rewrite.

## User Stories

1. As a pui maintainer, I want each feature's code contained in a single Module directory, so that the blast radius of a feature change is visible from the file tree.
2. As a pui maintainer, I want Modules forbidden from importing each other, so that features stay independently understandable and removable.
3. As a pui maintainer, I want a boundary-check script in the standard check gate, so that architectural violations fail CI instead of accumulating silently.
4. As a pui maintainer, I want the layer architecture to be the whole `src/` listing, so that newcomers can infer the design without reading docs first and without picking the layers out from among configs, docs, and tooling at the repo root.
5. As an AI agent contributor, I want a fixed Interfaces Directory convention (`pi`, `host`, `ui`, `api`), so that I can locate any Module's public surface without exploring its internals.
6. As an AI agent contributor, I want the glossary and architecture docs to match the directory layout, so that I don't act on stale structural descriptions.
7. As the Pi model, I want feature tools registered through each Module's Extension via Pi Core's Register File, so that tool availability is composed in exactly one place.
8. As a workflow author, I want my `.pui/` scripts' `"pui/workflow"` import to keep working unchanged, so that the refactor doesn't break my existing workflows.
9. As a pui user, I want the compiled binary to behave identically after the refactor, so that the release containing it is a non-event.
10. As a pui user running `pui workflow`, I want the headless path to work without loading any UI code, so that scripted runs stay lean.
11. As a Pi power user, I want each Module's Extension to remain loadable standalone via `pi -e`, so that I can use a single feature without the pui app.
12. As a Module author, I want the Child-Agent Runtime and Agent Roles available as a Shared Primitive, so that I can spawn child Pi processes without depending on the subagents Module.
13. As a Module author, I want generic utilities in a shared library separate from the Child-Agent Runtime, so that reaching for a validator doesn't entangle me with agent-spawning machinery.
14. As a UI developer, I want each Module to publish a UI Entry with its view models and protocol parsers, so that views never parse or deep-import feature wire formats themselves.
15. As a UI developer, I want the Controller and its collaborators inside the UI's state layer, so that render state and the components that consume it evolve together.
16. As an App-layer developer, I want the App reduced to entry points and process management with no UI coupling, so that process concerns stay separate from presentation.
17. As a reviewer, I want the refactor delivered as mechanical move commits on one branch, so that I can verify each step is behavior-preserving.
18. As a future maintainer, I want an ADR recording why Agent Roles belong to the Child-Agent Runtime, so that I don't mistakenly relocate them into the subagents Module.

## Implementation Decisions

- Five top-level layers under `src/`: `app/`, `pi-core/`, `modules/`, `shared/`, `ui/`. Only
  source lives in `src/`; `scripts/`, `docs/`, `issues/`, and `.pui/` stay at the repo root. The
  test-only helpers and the ambient asset declarations live at `src/test-support/` and
  `src/assets.d.ts` — there is no `extensions/` directory, since Extensions live inside their
  Modules. (An earlier revision of this decision kept the layers at the repo root; it was reversed
  once the root listing mixed them with a dozen non-source entries.)
- Four Modules: `subagents`, `workflows`, `web`, `file-search`. Each Module's only
  externally importable surface is its Interfaces Directory with fixed names:
  `pi` (the Extension; required; keeps a default export for standalone `pi -e`
  loading), `host` (Host Entry; required), `ui` (UI Entry; where needed), `api`
  (public authoring SDK; where needed). Everything else in a Module is private.
- Dependency edges, all one-way: App → UI start function + Pi Core + Module Host
  Entries; UI → Pi Core + Module UI Entries + shared + Pi SDK; Pi Core → Module
  Extensions + shared; Modules → shared + Pi SDK. No Module→Module edge, no
  UI→App edge, and Pi Core never imports a Host Entry. Shared is importable by
  every layer.
- Pi Core owns the Pi session lifecycle and all registration: the Register File
  (the single composition root listing every Extension), skill bundling with the
  embedded skills data moved under Pi Core, and AGENTS.md/guidance handling.
- The App layer is only entry points and pui process management: the TUI entry
  (CLI parsing, process start, invoking the UI's single start function) and the
  headless workflow entry (Pi Core + the workflows Host Entry, no UI imports).
- The Controller and its view-model collaborators (display-item formatting, shared
  view types, tool-execution tracking, dialog/toast queues) move into the UI as
  its state layer; OpenTUI/Solid components form the components layer. The UI
  exports one start function that owns renderer creation and mounting.
- Host-side feature bridges and view models (subagent view model, background
  subagent bridge, workflow bridge, and the workflow-specific portions of the
  shared formatters/types) move behind their Modules' UI Entries. Views consume
  parsed types from UI Entries instead of feature wire-format files, preserving
  the existing protocol-ownership policy through sanctioned entry points.
- Shared splits into two Shared Primitives: the Child-Agent Runtime (child Pi
  spawning, NDJSON streaming, the process-wide semaphore, Agent Roles with their
  guidance assets) and a generic library (validation, bounded process, retained
  output, JSON events, semaphore, background channel).
- Agent Roles (`worker`/`explore`/`generic`) belong to the Child-Agent Runtime,
  not the subagents Module — both subagents and workflows resolve models and
  timeouts from them. Recorded as ADR 0001. If workflows ever need genuine
  subagents-Module behavior, the fallback is extracting a shared subagent
  primitive, never a Module→Module edge.
- The `"pui/workflow"` package export is repointed at the workflows Module's
  `api` entry; the import specifier seen by workflow scripts is unchanged.
- Cross-layer imports are spelled with Node package subpath aliases (`package.json`
  `"imports"`: `#<layer>/*` → `./src/<layer>/*`); intra-layer and intra-Module imports
  stay relative. The `#` form is the one alias mechanism that Bun, `bun build`, `tsc`,
  and Pi's jiti loader (`pi -e`) all resolve natively — tsconfig `paths` breaks `pi -e`.
  The boundary check enforces the spelling both ways and rejects unresolvable `#`
  specifiers.
- Boundaries are enforced by convention plus a small boundary-check script
  (import-specifier scan asserting the edge list and the
  Interfaces-Directory-only rule) added to the standard check gate. UI→App is
  fully forbidden (not even type-only imports), since the Controller's move into
  the UI removes the need.
- Delivery: one refactor branch, a sequence of mechanical move commits with
  import-path fixes and no logic rewrites, landing as a single PR. The PR also
  updates the architecture and contribution docs, the package export map, test
  globs, and the build script.

## Testing Decisions

- A good test here exercises external behavior at a seam and never asserts on
  file locations or import structure directly — except the boundary checker,
  whose external behavior *is* judging import structure.
- Primary seam (existing): the full check gate — lint, typecheck, the complete
  test suite, binary build, and smoke build. Existing tests already sit at module
  boundaries, so they move with their Modules, receive import-path updates only,
  and must pass unchanged. A green check gate on the branch is the definition of
  behavior preserved.
- The one new seam: the boundary-check script, tested as a function from an
  import graph to a violation list. Fixture cases cover each forbidden edge
  (Module→Module, UI→App, Pi Core→Host Entry, any deep import bypassing an
  Interfaces Directory) plus a clean graph. It also runs against the real repo
  inside the check gate.
- Preserved public seams needing no new tests: the `"pui/workflow"` specifier
  (existing workflow API tests and the smoke build) and the `pi -e` default
  exports (existing registration tests).
- Prior art: the existing per-extension test suites and the smoke-build script
  already model both styles — boundary-level behavior tests and a
  build-then-probe check.

## Out of Scope

- Any behavior change, feature work, or logic rewrite in any Module, the UI, or
  Pi Core.
- Converting to Bun workspaces or multiple packages; the repo stays a single
  package with directory-plus-script enforcement.
- New features in the boundary checker beyond the agreed edge rules (no import
  cycles detection, no dead-code analysis).
- Renaming user-facing surfaces: CLI commands, tool names, the `"pui/workflow"`
  specifier, and wire protocols all stay as they are.
- Restructuring `.pui/` sample scripts beyond whatever the unchanged specifier
  already supports.

## Further Notes

- The domain vocabulary used here (Module, Extension, Pi Core, App, Controller,
  Register File, Shared Primitive, Child-Agent Runtime, Agent Role, Interfaces
  Directory, Host Entry, UI Entry) is defined in the repo-root glossary; keep the
  spec, docs, and code comments consistent with it.
- ADR 0001 ("Agent Roles belong to the Child-Agent Runtime") ships in this PR.
- The architecture doc rewrite replaces the current layer diagram and module
  tables; the contribution conventions (deep modules behind narrow interfaces,
  options-bag DI, protocol ownership) are unchanged in substance and should be
  restated against the new layout.
