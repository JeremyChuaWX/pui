# Contributing

- use conventional commits
- run `bun run check` before opening a pull request (Biome, `tsc`, the boundary check, the full
  test suite, a binary build, and a compiled-binary smoke test)
- use the domain vocabulary defined in the glossary in `CONTEXT.md` (Module, Extension, Pi Core,
  App, Controller, Register File, Shared Primitive, Child-Agent Runtime, Agent Role, Interfaces
  Directory, Host Entry, UI Entry) in code, comments, and docs
- follow the layer rules in `docs/ARCHITECTURE.md`: five top-level layers under `src/` (`app/`,
  `ui/`, `pi-core/`, `modules/`, `shared/`) with one-way dependency edges, enforced by
  `scripts/check-boundaries.ts` inside the check gate
- a feature lives in one Module under `src/modules/<name>/`; from outside a Module, import only its
  Interfaces Directory (`interfaces/pi.ts`, `interfaces/host.ts`, `interfaces/ui.ts`,
  `interfaces/api.ts`). Modules never import each other; cross-cutting code goes in `src/shared/`
- keep modules deep: hide significant machinery behind a narrow interface, inject collaborators
  through an options bag with production defaults, and test at the public interface with fakes
  (see the dependency-injection and testing sections of `docs/ARCHITECTURE.md`)
- wire formats have exactly one owner, the producing Module; consumers use the parsers and view
  models the Module publishes through its UI Entry instead of maintaining mirrors
- record architectural decisions with lasting consequences as ADRs in `docs/adr/`
