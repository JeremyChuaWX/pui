# Subagent extension

This extension supplies the `subagent` tool. Subagents are **not a Pi core feature**: the extension owns its trusted presets, queuing, child-process execution, cancellation, timeouts, and progress snapshots. Pi transports those snapshots as ordinary tool execution updates, so clients that do not understand the protocol still receive a normal tool result.

## Tool shape

Omit `agent` for a generic write-capable child with no bundled agent prompt:

```ts
{
  prompt: "Implement the focused task and run its tests",
  cwd: "/absolute/or/relative/path",
  model?: "provider/model:thinking"
}
```

Select the read-only explorer explicitly:

```ts
{
  agent: "explore",
  prompt: "Locate and explain the relevant code",
  cwd: "/absolute/or/relative/path",
  model?: "provider/model:thinking"
}
```

| Mode | Capabilities | Prompt | Default model | Timeout |
| --- | --- | --- | --- | --- |
| agent omitted | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | Pi's normal coding prompt with no bundled agent guidance; the input `prompt` steers the child | Child Pi's configured/default model | 10 minutes |
| `worker` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | Pi's normal coding prompt plus bundled worker and [Ponytail](https://ponytail.dev/) minimal-coding standards | `openai-codex/gpt-5.6-sol:low` | 10 minutes |
| `explore` | `read`, `grep`, `find`, `ls` | Dedicated read-only exploration prompt | `openai-codex/gpt-5.4-mini:off` | 120 seconds |

The omitted-agent mode adds no replacement or appended agent prompt and passes no model flag unless the call supplies `model`. Use it when the input task should be the only extra steering beyond Pi's normal coding context.

The explicit worker reads repository guidance itself, completes the delegated task, edits files, runs focused validation, and returns a concise handoff. Its self-contained, vendored Ponytail guidance favors existing code, the standard library, native platform features, installed dependencies, and the smallest correct diff while preserving validation, error handling, security, and accessibility. The upstream license is preserved in [`agents/worker-guidance.LICENSE`](./agents/worker-guidance.LICENSE).

All modes disable child sessions, extensions, skills, prompt templates, and automatic context-file loading. The worker prompt tells the child to discover `AGENTS.md` and contribution documentation before editing; omitted-agent calls receive no equivalent bundled instruction. No project-local or user-defined subagent presets are loaded, and the child cannot recursively load this extension.

Relative working directories resolve from the parent session's working directory. `~`, `~/...`, and the accidental leading `@` commonly produced by models are normalized before the directory is canonicalized.

## Security boundary

> **Omitted-agent and worker calls are write-capable and not sandboxed.** They can edit files and execute arbitrary shell commands. The child inherits the parent process environment, `cwd` is only its starting directory, and process/context isolation does not confine filesystem or operating-system access. Use write-capable delegation only in trusted repositories.

The explorer's Pi tool allowlist is read-only, but it is likewise not an operating-system sandbox and does not confine reads to `cwd` or scrub the inherited environment.

## Progress protocol

Every partial and final `details` value uses the versioned renderer-neutral protocol defined in [`protocol.ts`](./protocol.ts):

- `schema: "pi.subagent"`
- `version: 1`
- `run.id` equal to the outer Pi tool call ID
- a complete snapshot on every update, never an event delta
- at most 20 recent activity entries
- only currently executing child tools in `activeTools`
- aggregate finalized-assistant usage, final status, preview, and diagnostic metadata

Unknown future versions should be rendered as generic tools. Protocol details contain no raw child transcript or unbounded stdout/stderr. The final assistant text remains the ordinary model-visible tool `content` and final details are stored in the parent session's tool result.

When an execution throws, the extension temporarily retains terminal details by tool call ID and restores them in Pi's `tool_result` hook before session persistence.

## Configuration and limits

| Setting | Default | Purpose |
| --- | --- | --- |
| `PI_SUBAGENT_MAX_CONCURRENCY` | `4` | Process-wide child limit (valid range 1–64) |
| `PI_WORKER_MODEL` | `openai-codex/gpt-5.6-sol:low` | Model for the `worker` preset |
| `PI_EXPLORE_MODEL` | `openai-codex/gpt-5.4-mini:off` | Model for the `explore` preset |
| Omitted-agent/worker timeout | 10 minutes | Sends SIGTERM, then SIGKILL after a grace period |
| Explore timeout | 120 seconds | Sends SIGTERM, then SIGKILL after a grace period |
| Activity history | 20 entries | Bounds persisted progress metadata |
| Model-visible output | 50 KB or 2000 lines | Pi's normal tool-output limits |

A call's non-empty `model` value always overrides model selection. With no explicit agent, omitting `model` passes no model flag and lets child Pi select its configured/default model. Explicit worker and explorer calls next consult `PI_WORKER_MODEL` or `PI_EXPLORE_MODEL`, then use their bundled fallback.

Sibling outer tool calls are the concurrency unit. Additional calls stay visibly queued and can be cancelled before they spawn. Cancellation and timeout are separate terminal statuses.

If final output exceeds the model-visible limit, the extension writes the complete assistant output to a mode-`0600` file in a private temporary directory and includes its path in the result. No file is created for untruncated output.

## Troubleshooting

- **`Unable to start child Pi`**: ensure `pi` is on `PATH`. When the parent is Pi's CLI, the extension safely reuses that CLI entrypoint; SDK hosts do not reuse their own `argv[1]`.
- **Exited without a final assistant response**: inspect the bounded stderr/diagnostic in the failed tool result. Malformed JSONL lines are reported as diagnostics rather than crashing the parent.
- **Timed out**: narrow the delegated prompt or change the relevant preset timeout in `index.ts` after review.
- **Calls remain queued**: inspect `PI_SUBAGENT_MAX_CONCURRENCY`; invalid values fall back to four.
- **Full output path missing after truncation**: the result remains usable, but the private temporary file could not be created.

## Verification

From the repository root:

```bash
bun run check
```

For a focused extension run, use `bun test extensions/subagent`. Tests use `fixtures/fake-child.mjs` and do not call a model or the network.
