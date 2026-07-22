1. [ ] ability to have multiple threads?
2. [ ] make OpenTUI pui's only renderer
   - [ ] replace `CombinedAutocompleteProvider` and its `pi-tui` types with a local renderer-independent implementation
   - [ ] remove the subagent extension's dependency on the `pi-tui` `Text` component while preserving regular Pi compatibility
   - [ ] remove `@earendil-works/pi-tui` as a direct dependency (it will remain transitive through `pi-coding-agent`)
3. [ ] subagents need to be more generic, and agent parameter needs to be optional to allow for flexibility for model to call the subagent tool, for example when asked to make a implementer/worker subagent, model just spins off a bash tool call instead
4. [ ] code review after impl agent finishes
5. [ ] preserve terminal subagent protocol details for shutdown-interrupted executions; `session_shutdown` currently clears retained failure details before the `tool_result` hook can restore them
6. [ ] clarify or strengthen the subagent security boundary: the read-only preset restricts Pi tools but does not sandbox the filesystem, confine reads to `cwd`, or scrub the inherited environment
7. [ ] document the runner's actual signal escalation: SIGKILL occurs when the grace period expires, or immediately for the detached process group when the direct child exits during termination
