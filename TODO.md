1. [x] ctrl-p and ctrl-n for prompt history
2. [x] background colour of prompt box same as background colour of user message in chat window to better delineate prompt box
3. [x] focus should be trapped in prompt box
4. [x] allow for highlighting and copying to clipboard, but should not be auto-copied, still required cmd-c
5. [x] remove cost from subagent statusline
6. [x] remove placeholder text in prompt box
7. [ ] code review after impl agent finishes
8. [ ] ability to have multiple threads?
9. [ ] make OpenTUI pui's only renderer
   - [ ] replace `CombinedAutocompleteProvider` and its `pi-tui` types with a local renderer-independent implementation
   - [ ] remove the subagent extension's dependency on the `pi-tui` `Text` component while preserving regular Pi compatibility
   - [ ] remove `@earendil-works/pi-tui` as a direct dependency (it will remain transitive through `pi-coding-agent`)
