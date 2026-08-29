# 07: Three-part Limits watchdog

**Parent:** issues/0002-remove-workflows.md

**What to build:** Every Job runs under three Limits: a 60 minute wall clock, a 10 minute stall timeout while no child tool is active, and a 15 minute tool-stall timeout while one is. Streaming tool output resets the tool-stall timer. Each Limit ends the Job with its own terminal status and diagnostic, escalating SIGTERM to SIGKILL. Defaults live with the Profile type and any Profile may override them. The child runner is ported from the local pi extension rather than patched.

**Blocked by:** 05: `explorer` and `worker` spawn tools with Profile directories.

**Status:** done

- [x] A child that keeps calling tools past the wall clock is terminated with a status and diagnostic naming the wall clock
- [x] A child that produces no events while idle past the stall timeout is terminated with a status and diagnostic naming the stall
- [x] A child whose active tool produces no output past the tool-stall timeout is terminated with a status and diagnostic naming the tool stall; streaming output resets that timer
- [x] Termination escalates SIGTERM to SIGKILL on the whole process tree
- [x] Profile declarations may override any of the three Limits; tool descriptions state the effective Limits
- [x] Limits are tested at the Extension seam with an injected clock and scripted child events, never real sleeps
- [x] The old single `timeoutMs` and `PI_*` timeout handling are gone
- [x] `bun run check` is green
