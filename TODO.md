1. [x] ctrl-p and ctrl-n for prompt history
2. [x] background colour of prompt box same as background colour of user message in chat window to better delineate prompt box
3. [x] focus should be trapped in prompt box
4. [x] allow for highlighting and copying to clipboard, but should not be auto-copied, still required cmd-c
5. [x] remove cost from subagent statusline
6. [x] remove placeholder text in prompt box
7. [ ] ability to have multiple threads?
8. [ ] make OpenTUI pui's only renderer
   - [ ] replace `CombinedAutocompleteProvider` and its `pi-tui` types with a local renderer-independent implementation
   - [ ] remove the subagent extension's dependency on the `pi-tui` `Text` component while preserving regular Pi compatibility
   - [ ] remove `@earendil-works/pi-tui` as a direct dependency (it will remain transitive through `pi-coding-agent`)
9. [ ] subagents need to be more generic, and agent parameter needs to be optional to allow for flexibility for model to call the subagent tool, for example when asked to make a implementer/worker subagent, model just spins off a bash tool call instead
10. [x] tool calls in subagents dont need to be displayed in the subagent statusline to prevent flickering of ui
11. [ ] code review after impl agent finishes
12. [ ] preserve terminal subagent protocol details for shutdown-interrupted executions; `session_shutdown` currently clears retained failure details before the `tool_result` hook can restore them
13. [ ] clarify or strengthen the subagent security boundary: the read-only preset restricts Pi tools but does not sandbox the filesystem, confine reads to `cwd`, or scrub the inherited environment
14. [ ] document the runner's actual signal escalation: SIGKILL occurs when the grace period expires, or immediately for the detached process group when the direct child exits during termination
