# Agent Roles belong to the Child-Agent Runtime

Status: superseded by [ADR 0002](0002-subagents-owns-the-child-agent-runtime.md).

Both the subagents and workflows Modules resolve models, timeouts, and guidance from the Agent
Roles (`worker`/`explore`/`generic`), so the roles live in the Child-Agent Runtime
(`src/shared/agent-runtime/`, next to the spawning machinery they configure) rather than in the
subagents Module, where reading them from workflows would require a forbidden Module→Module edge.
Do not relocate them into the subagents Module; if workflows ever need genuine subagents-Module
behavior, the fallback is extracting a shared subagent primitive, never a Module→Module import.
