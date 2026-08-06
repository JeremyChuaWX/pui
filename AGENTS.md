- when contributing, review the contribution guide at CONTRIBUTION.md
- before structural changes, review the design and module map in docs/ARCHITECTURE.md
- follow the codebase conventions: deep modules behind narrow interfaces, dependencies injected as
  options objects with production defaults, wire protocols owned by the producing extension, and
  tests written at module boundaries (inject fakes through public seams; no private-API casts)
