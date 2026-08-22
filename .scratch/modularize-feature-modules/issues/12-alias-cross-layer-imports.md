# 12 — Alias cross-layer imports with `#<layer>/`

**Parent:** issues/0001-modularize-into-feature-modules.md

**What to build:** Cross-layer imports use Node package subpath imports (`package.json` `"imports"`: `#app/*`, `#ui/*`, `#pi-core/*`, `#modules/*`, `#shared/*`, `#test-support/*` → `./src/<layer>/*`), which Bun, `bun build`, `tsc` (NodeNext), and Pi's jiti loader all resolve natively (tsconfig `paths` does not survive `pi -e`). The rule is: relative within a layer or Module, `#` across. The boundary checker resolves `#` specifiers through the imports map, rejects unresolvable `#` specifiers, and rejects relative imports that cross a layer or Module boundary.

**Blocked by:** 11 — Move the layers under src/.

**Status:** open

- [ ] Every cross-layer import in `src/` uses a `#<layer>/` specifier; intra-layer and intra-Module imports stay relative
- [ ] `collectImportEdges` resolves `#` specifiers from the `package.json` imports map
- [ ] Fixture tests: unresolvable `#` specifier is a violation; a relative import crossing a layer/Module boundary is a violation; `#` cross-layer edges are judged by the existing rules
- [ ] `pi -e src/modules/<name>/interfaces/pi.ts` still loads standalone (jiti resolves `#shared/…`)
- [ ] Docs state the rule
- [ ] `bun run check` is green
