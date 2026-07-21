# Subagent extension

This extension supplies the `subagent` tool. Subagents are **not a Pi core feature**: the extension owns presets, queuing, child-process execution, cancellation, timeouts, and progress snapshots. Pi transports those snapshots as ordinary tool execution updates, so clients that do not understand the protocol still receive a normal tool result.

See [`docs/subagent-architecture.md`](../../docs/subagent-architecture.md) for host integration, ownership boundaries, and persistence design.

## Tool shape

```ts
{
  agent: "explore",
  prompt: "Focused delegated task",
  cwd: "/absolute/or/relative/path",
  model?: "provider/model:thinking"
}
```

The built-in `explore` preset is intentionally read-only. Child Pi runs with only `read`, `grep`, `find`, and `ls`, and with sessions, extensions, skills, prompt templates, and context files disabled. Project-local or write-capable presets are not loaded.

Relative working directories resolve from the parent session's working directory. `~`, `~/...`, and the accidental leading `@` commonly produced by models are normalized before the directory is canonicalized.

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
| `PI_EXPLORE_MODEL` | `openai-codex/gpt-5.4-mini:off` | Model for the `explore` preset |
| Preset timeout | 120 seconds | Sends SIGTERM, then SIGKILL after a grace period |
| Activity history | 20 entries | Bounds persisted progress metadata |
| Model-visible output | 50 KB or 2000 lines | Pi's normal tool-output limits |

Sibling outer tool calls are the concurrency unit. Additional calls stay visibly queued and can be cancelled before they spawn. Cancellation and timeout are separate terminal statuses.

If final output exceeds the model-visible limit, the extension writes the complete assistant output to a mode-`0600` file in a private temporary directory and includes its path in the result. No file is created for untruncated output.

## Troubleshooting

- **`Unable to start child Pi`**: ensure `pi` is on `PATH`. When the parent is Pi's CLI, the extension safely reuses that CLI entrypoint; SDK hosts do not reuse their own `argv[1]`.
- **Exited without a final assistant response**: inspect the bounded stderr/diagnostic in the failed tool result. Malformed JSONL lines are reported as diagnostics rather than crashing the parent.
- **Timed out**: narrow the delegated prompt or change the preset timeout in `index.ts` after review.
- **Calls remain queued**: inspect `PI_SUBAGENT_MAX_CONCURRENCY`; invalid values fall back to four.
- **Full output path missing after truncation**: the result remains usable, but the private temporary file could not be created.

## Verification

From the repository root:

```bash
npm run check
```

For a focused extension run, use `bun test extensions/subagent`. Tests use `fixtures/fake-child.mjs` and do not call a model or the network.
