# The subagents Module owns the child-agent runtime

Status: accepted. Supersedes [ADR 0001](0001-agent-roles-belong-to-the-child-agent-runtime.md).

ADR 0001 put the child-agent runtime and its Agent Roles in `src/shared/agent-runtime/` because
two Modules, subagents and workflows, created child Pi runtimes. Workflows is deleted, so the
runtime has one consumer. A shared layer with one consumer is indirection without reuse: every
change crosses a boundary that protects nothing, and the glossary carries a name for a thing no
second Module reads.

The subagents Module now owns all of it in `src/modules/subagents/`: the two Profiles
(`explorer` and `worker`) under `profiles/`, the isolated child `AgentSession` runner in
`subagent.ts`, the Manager and Limits, result messages, and the Background Protocol/UI bridge.
`src/shared/lib/` keeps only code with two or more consumers today. ADR 0003 records the later
choice to align this runtime with the local Pi subagent Extension.

The trade-off is that a future second consumer of child AgentSessions would have to extract the runtime
back out. That is the right time to pay for a shared layer, not before. Do not re-extract a
child-agent Shared Primitive on the strength of a hypothetical consumer; a Module-to-Module import
stays forbidden, so a real second consumer means moving the runtime to `src/shared/` in the same
change that adds it.
