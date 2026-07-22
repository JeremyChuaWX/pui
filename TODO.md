1. [x] ctrl-p and ctrl-n for prompt history
2. [ ] focus should be trapped in prompt box
3. [ ] allow for highlighting and copying to clipboard, but should not be auto-copied, still required cmd-c
4. [ ] remove cost from subagent statusline
5. [ ] remove placeholder text in prompt box
6. [ ] code review after impl agent finishes
7. [ ] ability to have multiple threads?
8. [ ] make OpenTUI pui's only renderer
   - [ ] replace `CombinedAutocompleteProvider` and its `pi-tui` types with a local renderer-independent implementation
   - [ ] remove the subagent extension's dependency on the `pi-tui` `Text` component while preserving regular Pi compatibility
   - [ ] remove `@earendil-works/pi-tui` as a direct dependency (it will remain transitive through `pi-coding-agent`)
