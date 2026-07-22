1. [ ] ability to have multiple threads?
2. [ ] make OpenTUI pui's only renderer
   - [ ] replace `CombinedAutocompleteProvider` and its `pi-tui` types with a local renderer-independent implementation
   - [ ] remove the subagent extension's dependency on the `pi-tui` `Text` component while preserving regular Pi compatibility
   - [ ] remove `@earendil-works/pi-tui` as a direct dependency (it will remain transitive through `pi-coding-agent`)
3. [x] make `agent` optional: omitted calls use an unguided write-capable child, while explicit `worker` and read-only `explore` presets remain available
4. [ ] code review after impl agent finishes
5. [ ] preserve terminal subagent protocol details for shutdown-interrupted executions; `session_shutdown` currently clears retained failure details before the `tool_result` hook can restore them
6. [ ] clarify or strengthen the subagent security boundary: the read-only preset restricts Pi tools but does not sandbox the filesystem, confine reads to `cwd`, or scrub the inherited environment
7. [ ] document the runner's actual signal escalation: SIGKILL occurs when the grace period expires, or immediately for the detached process group when the direct child exits during termination
