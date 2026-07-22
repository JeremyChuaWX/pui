# Product work

- [ ] Support multiple independent conversation threads.

## Deliberate dependency boundary

`pui` uses OpenTUI for rendering, while `src/controller.ts` intentionally uses
`CombinedAutocompleteProvider` from `@earendil-works/pi-tui` for slash commands,
paths, `fd` search, quoting, ranking, cancellation, and completion insertion.
Keep `@earendil-works/pi-tui` as a direct dependency while that import remains.
The bundled subagent extension is renderer-neutral and regular Pi renders it
through Pi's generic tool fallback.
