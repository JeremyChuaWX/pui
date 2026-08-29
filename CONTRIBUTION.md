# Contributing

- use conventional commits
- run `bun run check` before opening a pull request (Biome, `tsc`, the boundary check, the full
  test suite, a binary build, and a compiled-binary smoke test)
- use the domain vocabulary defined in the glossary in `CONTEXT.md` (Module, Extension, Pi Core,
  App, Controller, Register File, Shared Primitive, Interfaces Directory, UI Entry, Profile, Job,
  Limits, Background Protocol) in code, comments, and docs
- follow the layer rules in `docs/ARCHITECTURE.md`: five top-level layers under `src/` (`app/`,
  `ui/`, `pi-core/`, `modules/`, `shared/`) with one-way dependency edges, enforced by
  `scripts/check-boundaries.ts` inside the check gate
- a feature lives in one Module under `src/modules/<name>/`; from outside a Module, import only its
  Interfaces Directory (`interfaces/pi.ts`, required, and `interfaces/ui.ts` where the UI needs
  it). Modules never import each other. Code with two or more consuming Modules goes in
  `src/shared/`; code with one consumer stays in that Module (ADR 0002)
- spell imports relative within a layer or Module and with the `#<layer>/` alias across
  (`#shared/lib/validate.js`, `#modules/web/interfaces/pi.js`); the boundary check rejects
  both a relative cross-layer import and an alias used inside one layer
- keep modules deep: hide significant machinery behind a narrow interface, inject collaborators
  through an options bag with production defaults, and test at the public interface with fakes
  (see the dependency-injection and testing sections of `docs/ARCHITECTURE.md`)
- wire formats have exactly one owner, the producing Module; consumers use the parsers and view
  models the Module publishes through its UI Entry instead of maintaining mirrors
- record architectural decisions with lasting consequences as ADRs in `docs/adr/`
