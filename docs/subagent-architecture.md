# Subagent architecture

This document records the current subagent design and the boundaries that future changes should preserve. Operational configuration and troubleshooting live in [`extensions/subagent/README.md`](../extensions/subagent/README.md).

## Overview

Subagents are provided by the bundled Pi extension in [`extensions/subagent/`](../extensions/subagent/). They are not a Pi core feature.

The extension launches isolated child Pi processes and publishes renderer-neutral progress through ordinary Pi tool updates. pi-tui consumes those updates, converts recognized protocol data into a bounded view model, and falls back to a generic tool card for data it does not recognize.

```text
parent Pi tool call
  -> bundled subagent extension
  -> isolated child Pi JSON event stream
  -> complete pi.subagent progress snapshots
  -> Pi tool_execution_* events
  -> pi-tui tool execution reducer
  -> defensive protocol normalization
  -> transcript card and sidebar
```

## Ownership

### Extension

[`extensions/subagent/`](../extensions/subagent/) owns:

- preset definitions and child tool allowlists;
- model selection and environment overrides;
- working-directory validation;
- process spawning, concurrency, timeout, and cancellation;
- child JSON event parsing and progress aggregation;
- the canonical protocol producer;
- output limits and private full-output files;
- regular Pi rendering;
- extension and runner tests.

### Host application

[`src/`](../src/) owns:

- loading the bundled extension into each embedded Pi runtime;
- reducing generic Pi tool execution events;
- reconciling live execution state with persisted messages;
- defensive parsing of untrusted `details` values;
- legacy protocol adaptation and generic fallback;
- OpenTUI transcript and sidebar presentation.

### Pi core

Pi core remains unchanged. It transports standard tool lifecycle events and persists the final tool result.

## Runtime loading

[`src/bundled-extensions.ts`](../src/bundled-extensions.ts) resolves the extension entry point relative to the application module and exports an absolute path. [`src/controller.ts`](../src/controller.ts) passes that path to Pi through `additionalExtensionPaths` whenever it creates session services.

This has several important properties:

- loading is independent of the shell or session working directory;
- replacement sessions receive the same bundled extension;
- normal global and trusted project extension discovery remains enabled;
- `/reload` uses Pi's normal extension lifecycle;
- the application does not depend on a copy under `~/.pi`.

The regular `pi` command does not automatically load application-bundled extensions. It can load this source explicitly with `pi -e /absolute/path/to/extensions/subagent/index.ts`.

## Protocol

The producer contract is defined in [`extensions/subagent/protocol.ts`](../extensions/subagent/protocol.ts). Every recognized value has:

```ts
{
  schema: "pi.subagent";
  version: 1;
  run: {
    id: string;
    agent: string;
    model: string;
    cwd: string;
    status: "queued" | "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
    // phase, timing, activity, usage, preview, and diagnostic fields
  };
}
```

Protocol invariants:

1. `run.id` equals the outer tool call ID.
2. Each update is a complete snapshot, not an event delta.
3. Recent activity, output previews, and diagnostics are bounded.
4. `activeTools` contains only currently running child tools.
5. Terminal states have an end time and no active tools.
6. The final assistant output remains ordinary tool-result content.
7. Raw child transcripts and unbounded stdout or stderr are not persisted in details.
8. Unknown versions remain generic tools.

[`src/subagent.ts`](../src/subagent.ts) intentionally validates `unknown` data instead of trusting extension-owned objects. It also adapts the legacy `{ agent, model, toolCalls, usage }` shape for old sessions. The producer and consumer validators should remain independent even if inert protocol types or constants are shared later.

## Execution lifecycle

The bundled `explore` preset is read-only. A child starts with sessions, extensions, skills, prompt templates, and context files disabled, and receives only its configured tools.

Each outer tool call is one independently tracked subagent. A process-wide abortable semaphore limits active children; queued calls can be cancelled before spawning. Running children receive `SIGTERM` on cancellation or timeout and, after a grace period, `SIGKILL`. On supported platforms the runner signals the detached process group so tool descendants do not survive.

The runner consumes child Pi's newline-delimited JSON events and derives:

- lifecycle phase and status;
- active and recent child tools;
- bounded live output preview;
- aggregate finalized-assistant usage;
- final output or a bounded diagnostic.

Malformed child output becomes diagnostic activity rather than crashing the parent.

## Results and persistence

Successful output is returned as normal model-visible tool content. If it exceeds Pi's output limits, the extension returns the truncated content and may write the complete output to a private temporary file.

Pi currently marks thrown tool executions as errors before the extension can return structured failure details normally. The extension therefore retains terminal failure details by tool call ID and restores them in a `tool_result` hook. Retained details are removed after use and cleared on session shutdown.

Final protocol details are persisted with the parent session. pi-tui can therefore recreate completed subagent cards without replaying live events.

## Host presentation path

The host pipeline is:

1. [`src/tool-executions.ts`](../src/tool-executions.ts) reduces `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events.
2. [`src/controller.ts`](../src/controller.ts) reconciles event state with pending calls and persisted tool results.
3. [`src/format.ts`](../src/format.ts) combines messages and live executions into display items.
4. [`src/subagent.ts`](../src/subagent.ts) converts recognized details into a bounded view model.
5. [`src/app.tsx`](../src/app.tsx) renders live or restored cards and the active-subagent sidebar group.

Generic tools use the same event reducer. Subagent presentation is selected by structured details, not by the tool name alone.

## Verification and change rules

The repository test suite covers protocol invariants, parsing, process cleanup, concurrency, persistence, runtime replacement, host normalization, and generic fallback:

```bash
npm run check
```

Changes to the runner or protocol should also preserve these manual checks:

- narrow and wide terminal layouts;
- one live successful subagent;
- cancellation and timeout;
- sibling calls completing out of order;
- `/reload`, `/new`, and session resume;
- explicit loading by regular Pi.

Do not:

- move subagent behavior into Pi core or a host-only custom tool;
- identify subagents only by tool name;
- mount Pi TUI renderer components inside OpenTUI;
- load project-defined or write-capable presets without a separate trust review;
- merge the producer and defensive consumer validators merely to remove duplicated lines.
