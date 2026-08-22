# 12 — Alias cross-layer imports with `#<layer>/`

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** Cross-layer imports use Node package subpath imports (`package.json` `"imports"`: `#app/*`, `#ui/*`, `#pi-core/*`, `#modules/*`, `#shared/*`, `#test-support/*` → `./src/<layer>/*`), which Bun, `bun build`, `tsc` (NodeNext), and Pi's jiti loader all resolve natively (tsconfig `paths` does not survive `pi -e`). The rule is: relative within a layer or Module, `#` across. The boundary checker resolves `#` specifiers through the imports map, rejects unresolvable `#` specifiers, and rejects relative imports that cross a layer or Module boundary.

**Blocked by:** 11 — Move the layers under src/.

**Status:** done (commit ab0955a on `modularize-feature-modules`)

- [x] Every cross-layer import in `src/` uses a `#<layer>/` specifier; intra-layer and intra-Module imports stay relative
- [x] `collectImportEdges` resolves `#` specifiers from the `package.json` imports map
- [x] Fixture tests: unresolvable `#` specifier is a violation; a relative import crossing a layer/Module boundary is a violation; `#` cross-layer edges are judged by the existing rules
- [x] `pi -e src/modules/<name>/interfaces/pi.ts` still loads standalone (jiti resolves `#shared/…`; verified by loading every Extension through jiti — file-search and web load, subagents and workflows fail identically before and after this change on jiti's handling of the `with { type: "text" }` Markdown imports in `presets.ts`, a pre-existing issue outside this scope)
- [x] Docs state the rule
- [x] `bun run check` is green
