1. [ ] ability to have multiple threads?
2. [ ] make OpenTUI pui's only renderer
   - [ ] replace `CombinedAutocompleteProvider` and its `pi-tui` types with a local renderer-independent implementation
   - [ ] remove the subagent extension's dependency on the `pi-tui` `Text` component while preserving regular Pi compatibility
   - [ ] remove `@earendil-works/pi-tui` as a direct dependency (it will remain transitive through `pi-coding-agent`)
3. [ ] code review after impl agent finishes
