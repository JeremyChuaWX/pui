# Review priorities

Prioritize demonstrable correctness, security, lifecycle, compatibility, and
resource-management problems. Avoid purely stylistic feedback already enforced
by Biome or TypeScript.

## File-search extension

- Treat shell interpolation, option injection, unbounded output, temporary-file
  leakage, weak private-file permissions, and incomplete process-tree cleanup as
  high-risk findings.
- Verify timeout and cancellation paths on both supported POSIX platforms and do
  not assume a fast child-process startup.

## Subagent extension

- Check FIFO concurrency, cancellation and shutdown races, exact-once result
  delivery, bounded wire fields, stale session or instance rejection, and child
  process-tree cleanup.
- Preserve renderer-neutral protocol details and compatibility with persisted
  sessions and unknown protocol versions.

## Host and UI

- Check controller rebinding and disposal for stale events, leaked listeners,
  leaked child processes, and inconsistent snapshots.
- Check interactive changes for keyboard accessibility and stable resumed-session
  rendering.

## Tests and workflows

- Flag timing assumptions that can be flaky across Linux and macOS runners.
- Require meaningful failure-path assertions, least-privilege workflow
  permissions, frozen dependency installation, and bounded CI execution.
