# Shared Agent Execution Infrastructure Plan

Status: proposed

## Goal

Extract child-Pi execution into one neutral, reusable runtime used by both the bundled subagent and workflow extensions.

The refactor should:

1. remove workflow imports from `extensions/subagent/` internals;
2. give blocking subagents, background subagents, workflow agents, and agents from concurrent workflow runs one process-wide FIFO execution limit;
3. preserve the existing `pi.subagent` and `pi.workflow` wire protocols, tools, persistence, approvals, and UI behavior;
4. keep extension-specific lifecycle, delivery, recovery, worktree, schema, and output-retention policy outside the shared runtime; and
5. keep recursive extension loading disabled.

## Current problem

The workflow extension currently reuses subagent implementation files directly:

- `extensions/workflow/index.ts` imports presets, protocol state, invocation, and `runSubagent` from `extensions/subagent/`;
- `extensions/workflow/backend.ts` imports the subagent semaphore implementation;
- the workflow default executor creates an otherwise invisible `pi.subagent` snapshot only to drive the child runner.

This couples workflow execution to another extension's private protocol and directory layout.

Concurrency is also split:

- blocking and background subagents share the process-wide semaphore in `extensions/subagent/index.ts`;
- every workflow run creates a separate per-run semaphore in `extensions/workflow/backend.ts`;
- workflow agents do not acquire the subagent process-wide semaphore.

Consequently, subagents and workflows can coexist but do not share process capacity or FIFO fairness. Multiple workflow runs can also each consume their full local limit.

## Design decisions

### Shared runtime module owns

- built-in `generic`, `worker`, and `explore` presets;
- shared model-resolution helpers and unchanged child Pi CLI arguments;
- Pi executable resolution;
- one process-wide, abort-aware FIFO scheduler;
- child process spawning and detached process-group cleanup;
- JSONL event parsing;
- neutral execution snapshots, activity, active tools, usage, output preview, diagnostics, and terminal status;
- execution timeout after a process receives a global permit; and
- raw terminal assistant output and bounded stderr/diagnostics.

### Extension adapters continue to own

**Subagent:**

- tool schemas and prompt guidance;
- `pi.subagent` and `pi.subagent.background` envelopes;
- tool-call IDs and background job IDs;
- session-scoped background job tracking;
- deferred/waited result delivery;
- full-output retention and cleanup; and
- session shutdown signals.

**Workflow:**

- script approval and saved definitions;
- restricted orchestration worker transport;
- per-run concurrency and budgets;
- phase and operation identity;
- retries, JSON Schema prompting/parsing/validation, and durable completion;
- worktree isolation;
- recovery, controls, and terminal delivery; and
- `pi.workflow` snapshots and background envelopes.

### Explicit non-goals

- Do not merge the `pi.subagent` and `pi.workflow` protocols.
- Do not make workflow scripts call the registered `subagent` tool.
- Do not enable extensions, skills, context files, sessions, or prompt templates in child Pi processes.
- Do not allow recursive subagents or nested workflows in this refactor.
- Do not move workflow recovery, journaling, worktrees, or schema validation into the shared runtime.
- Do not count the restricted JavaScript orchestration worker as a child-Pi scheduler permit; only model-backed child Pi executions consume permits.

## Proposed architecture

```text
Subagent tool ───────────────┐
BackgroundSubagentManager ───┼─> subagent adapter ─┐
                                                │
Workflow backend ───────────────> workflow adapter ├─> AgentExecutionRuntime
                                                │       ├─ preset/model resolution
                                                │       ├─ process-wide FIFO scheduler
                                                │       ├─ Pi invocation
                                                │       └─ child process runner
                                                │
                                                ├─> pi.subagent protocol/persistence
                                                └─> pi.workflow protocol/persistence
```

Create a non-registering shared module:

```text
extensions/agent-runtime/
  index.ts
  types.ts
  state.ts
  presets.ts
  scheduler.ts
  runner.ts
  json-events.ts
  agents/
    explore.md
    worker.md
    worker-guidance.LICENSE
```

`extensions/agent-runtime/` is infrastructure, not a Pi extension, and must not register tools or lifecycle hooks.

### Neutral API

The implementation may refine names, but the boundary should remain equivalent to:

```ts
export type AgentPresetName = "generic" | "worker" | "explore";

export interface AgentExecutionRequest {
  id: string;
  preset: AgentPresetName;
  prompt: string;
  cwd: string;                 // absolute, validated by the caller/shared cwd helper
  model?: string;              // resolved through the shared preset helper
  timeoutMs: number;
  signal?: AbortSignal;        // owner cancellation, shutdown, and optional outer deadline
}

export interface AgentExecutionSnapshot {
  id: string;
  preset: AgentPresetName;
  model: string;
  cwd: string;
  status:
    | "queued"
    | "starting"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out";
  phase?: "queued" | "spawning" | "thinking" | "tool" | "exiting";
  startedAt?: number;
  updatedAt: number;
  endedAt?: number;
  activeTools: AgentActiveTool[];
  recentActivity: AgentActivity[];
  usage: AgentUsage;
  outputPreview?: string;
  error?: string;
}

export interface AgentExecutionResult {
  snapshot: AgentExecutionSnapshot;
  output: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface AgentExecutionRuntime {
  execute(
    request: AgentExecutionRequest,
    hooks?: { onSnapshot?: (snapshot: AgentExecutionSnapshot) => void },
  ): Promise<AgentExecutionResult>;
}
```

Once a request passes input validation, the runtime must always resolve with a valid terminal snapshot, including cancellation while globally queued and child spawn failure. Only invalid requests or failures before an execution is accepted may reject. Adapter callback exceptions must remain unable to strand or alter the child process.

The shared runtime must not return `pi.subagent` or `pi.workflow` envelopes and must not write session-specific full-output files.

### Process-wide instance

Provide both:

- `createAgentExecutionRuntime(options)` for tests and embedders; and
- `getProcessAgentExecutionRuntime()` for default extension registration.

The process runtime should be stored under a versioned `Symbol.for(...)` key on `globalThis`, avoiding a subagent-named global. `src/bundled-extensions.ts` should explicitly create/inject one runtime into both bundled extension factories so the shared ownership is visible and testable. Standalone `pi -e` loading should fall back to the process singleton.

The shared runtime itself has no session-level `shutdown()` method. Each extension owns abort signals for its work. Session replacement must cancel only work owned by the old extension instances while leaving the process scheduler reusable by replacement instances.

## Concurrency and timeout semantics

### Global and local limits

Use two independent limits:

1. **Global child-Pi limit:** one process-wide FIFO scheduler shared by all subagent and workflow executions.
2. **Workflow run limit:** the existing per-run semaphore continues to bound one workflow's fan-out and remains capped at 16.

A workflow operation acquires its per-run permit first, then queues for the global permit. It releases the global permit when the child process settles and the per-run permit after workflow-specific validation, persistence, and cleanup complete.

This preserves workflow scheduling bounds without allowing one or many workflows to bypass process capacity.

### Fairness

- Global acquisition order is strict FIFO among requests that have reached the global scheduler.
- No extension or role receives priority in the initial implementation.
- An aborted queued request is removed without consuming a permit.
- Permit release is idempotent.
- Queue ownership is observable through the caller's neutral `queued` snapshot, not a global UI.

### Timeouts

The shared scheduler does not create deadlines.

- Subagent preset timeout starts after the request receives a global permit, preserving current subagent behavior.
- The low-level runner enforces execution timeout and process-group termination.
- Workflow's existing outer agent deadline remains authoritative and may abort a request while it is waiting for the global permit.
- Workflow retries reacquire both local and global permits for each new child execution attempt.
- Tests must distinguish queued cancellation, execution timeout, workflow outer timeout, explicit stop, and session shutdown.

### Configuration

Introduce `PI_AGENT_MAX_CONCURRENCY` as the shared setting, valid from 1 through 64.

Compatibility order:

1. valid `PI_AGENT_MAX_CONCURRENCY`;
2. otherwise valid legacy `PI_SUBAGENT_MAX_CONCURRENCY`;
3. otherwise default 4.

Invalid, fractional, zero, negative, or greater-than-64 values do not configure capacity and fall through to the next source. Keep `PI_SUBAGENT_MAX_CONCURRENCY` documented as a compatibility alias for at least the current release. Workflow `limits.maxConcurrency` remains a per-run limit and cannot raise the global process limit.

## Implementation phases

### Phase 0: characterization and contract tests

Before moving code:

- add golden/structural tests for current `pi.subagent` partial and terminal details;
- preserve child CLI flags, preset prompts, model precedence, timeout values, process invocation resolution, JSONL parsing, usage aggregation, process-tree termination, and valid/invalid legacy concurrency configuration;
- characterize old-instance control-listener teardown and queued/running cancellation across reload, new session, switch, fork, and disposal;
- prepare a cross-source scheduler test that demonstrates the current ability to exceed a global limit of one, but land its shared-capacity assertion only with the implementation that makes it pass; and
- record current shutdown behavior for queued and running blocking/background/workflow work.

Exit criteria:

- landed tests describe existing protocol and child-process behavior without model or network calls;
- the cross-source harness reproduces the gap locally without leaving the branch red.

### Phase 1: extract neutral primitives without changing scheduling

Move and neutralize:

- `extensions/subagent/semaphore.ts` to `extensions/agent-runtime/scheduler.ts`;
- `extensions/subagent/json-events.ts` to `extensions/agent-runtime/json-events.ts`;
- presets and prompt assets to `extensions/agent-runtime/presets.ts` and `agents/`;
- UTF-8 bounding and usage aggregation needed by the runner into neutral state utilities; and
- `extensions/subagent/runner.ts` to a protocol-neutral `extensions/agent-runtime/runner.ts`.

Replace `SubagentDetailsV1` input/output in the runner with `AgentExecutionSnapshot`. Keep process spawning, throttling, diagnostics, timeout, signal, and SIGTERM/SIGKILL behavior unchanged.

Keep the `pi.subagent` protocol file extension-owned. It may adapt or re-export neutral text/usage helpers, but its schema, version, validation, and wire bounds remain authoritative.

Update unit tests under `extensions/agent-runtime/`. Keep the currently exported `getPiInvocation` compatibility export from `extensions/subagent/index.ts`, backed by the new implementation.

Exit criteria:

- no behavior or concurrency change;
- neutral runtime tests cover every former runner and semaphore scenario;
- subagent protocol tests remain unchanged at the wire boundary; and
- standalone subagent loading still resolves moved prompt assets.

### Phase 2: migrate blocking and background subagents

Change `registerSubagentExtension` and `BackgroundSubagentManager` to consume an injected `AgentExecutionRuntime` rather than separately receiving a semaphore, invocation resolver, and protocol-coupled runner.

The subagent adapter should:

- validate/resolve cwd and model before execution;
- convert neutral snapshots to `SubagentDetailsV1` without changing fields or IDs;
- keep outer tool updates and background events unchanged;
- retain failed terminal details for the existing `tool_result` persistence repair;
- retain full-output spill, wait, automatic delivery, and cleanup behavior;
- remove old-instance event-bus control listeners before emitting reset; and
- abort owned queued/running work on shutdown without shutting down the shared runtime.

Update dependency injection in tests to use a fake runtime or `createAgentExecutionRuntime` with an injected fake child runner.

Exit criteria:

- blocking and background calls still share FIFO capacity;
- all existing subagent SDK, lifecycle, output, and protocol tests pass;
- session replacement reuses the scheduler and does not inherit jobs; and
- no subagent adapter code directly acquires a semaphore or spawns Pi.

### Phase 3: add the workflow execution adapter

Create `extensions/workflow/agent-executor.ts` to translate a workflow `AgentRequest` into the neutral runtime.

The adapter should:

- resolve only allowed shared presets;
- append the existing JSON-only schema instruction when requested;
- pass the stable workflow operation ID into the runtime;
- parse structured output exactly as today;
- return raw output/structured value and usage to the backend; and
- convert neutral progress into bounded workflow-agent activity without exposing a `pi.subagent` envelope.

Extend the backend's `AgentRequest` seam with a stable operation ID and an optional progress callback. Workflow remains authoritative for terminal success: a neutral child `succeeded` snapshot must not mark the workflow operation succeeded until JSON parsing, schema validation, budget checks, durable journaling, and worktree cleanup succeed.

Change `extensions/workflow/backend.ts` to import the neutral semaphore only for its per-run limit. Remove all imports from `extensions/subagent/`.

Exit criteria:

- workflow default execution contains no subagent protocol objects;
- workflow agents acquire both per-run and process-wide capacity;
- active workflow agent model, usage, bounded activity, and preview can be updated from neutral snapshots;
- workflow retries, stop, shutdown interruption, recovery, and worktree behavior remain unchanged; and
- custom injected `WorkflowBackendOptions.agentExecutor` implementations remain supported.

### Phase 4: explicit bundled wiring and integration coverage

Update `src/bundled-extensions.ts` to create or accept one shared runtime and inject it into both extension factories. Preserve `BUNDLED_EXTENSION_FACTORIES` as the production export; optionally expose a factory creator for hermetic tests.

Add integration tests using a gated fake child runner and global capacity one:

1. running blocking subagent queues a workflow agent;
2. running workflow agent queues a background subagent;
3. requests from two workflow runs and one subagent start in FIFO order;
4. queued subagent cancellation does not spawn or consume a permit;
5. workflow stop while globally queued produces the correct terminal state;
6. workflow timeout while globally queued is `timed_out`, not generic failure;
7. old-session shutdown cancels only old-session work and a replacement instance can immediately reuse released capacity;
8. one adapter throwing from a progress callback cannot block another request; and
9. all permits return after spawn failure, timeout, SIGKILL escalation, schema failure, and output-store failure.

Also add a wiring test that asserts the two bundled factories receive the same runtime object, while independently loaded extensions fall back to the process singleton.

Keep tests model-free and network-free. Use the existing fake child fixture or an injected runner rather than invoking a paid model.

Exit criteria:

- one observed active-child count never exceeds the configured global limit across all sources;
- bundled tool counts and session replacement tests still pass; and
- standalone loading of either extension still works without the other being registered.

### Phase 5: cleanup, docs, and compiled verification

- remove obsolete protocol-coupled runner/semaphore/preset files and update imports;
- update `extensions/subagent/README.md`, `extensions/workflow/README.md`, and the root `README.md` with the shared global limit and legacy environment alias;
- update architecture notes to identify `extensions/agent-runtime/` as a shared non-extension module;
- update `package.json` test targets to include `extensions/agent-runtime`;
- update bundled-source/asset tests for moved prompt and license files;
- run the compiled workflow smoke and add a no-model compiled check that moved assets and Pi invocation resolution remain available; and
- run `bun run check`.

Exit criteria:

- no source under `extensions/workflow/` imports from `extensions/subagent/`;
- no source under `extensions/agent-runtime/` imports either extension protocol or manager;
- documentation distinguishes global process capacity from workflow per-run capacity; and
- source tests, typecheck, build, and compiled smoke all pass.

## Test matrix

### Shared runtime unit tests

- FIFO order and idempotent release;
- abort before queueing, while queued, while spawning, and while running;
- spawn error and malformed/fragmented JSONL;
- multiple active tools and bounded activity;
- model label stabilization and usage aggregation;
- output/stderr/diagnostic bounds;
- timeout then process-group SIGTERM/SIGKILL;
- callback exceptions;
- singleton/config precedence; and
- no permit leaks on every terminal path.

### Subagent regression tests

- unchanged tool parameters, result content, and `pi.subagent` details;
- blocking/background shared queue;
- wait abort does not cancel work;
- explicit cancellation while queued/running;
- terminal detail persistence on thrown tools;
- output spill ownership and cleanup; and
- reload/new/switch/fork/dispose lifecycle behavior.

### Workflow regression tests

- sequential, parallel, pipeline, retry, and structured results;
- per-run limit combined with the global limit;
- multiple concurrent runs;
- pause starts no new operations;
- stop aborts queued and active children;
- shutdown remains recoverable;
- durable completions replay without another permit or model execution;
- worktree cleanup and branch retention; and
- workflow summaries remain valid while neutral progress streams.

### Compatibility tests

- persisted `pi.subagent` v1 details still normalize and render;
- persisted workflow artifacts recover without migration;
- no tool or command names change;
- old `PI_SUBAGENT_MAX_CONCURRENCY` still configures shared capacity;
- child Pi still receives `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, and the same role tool allowlists; and
- regular `pi -e .../extensions/subagent/index.ts` and workflow-only loading remain usable.

## Risks and mitigations

### Protocol drift

Neutralizing runner state could accidentally alter timestamps, activity sequence, model labels, usage, or terminal fields. Protect the boundary with golden protocol tests before extraction and keep adapters explicit.

### Workflow durability ordering

The child runner finishes before workflow schema validation and journal persistence. Never project neutral `succeeded` directly to durable workflow success; only the backend can commit that transition.

### Queue timeout ambiguity

Queued cancellation, workflow outer timeout, child timeout, explicit stop, and shutdown currently travel through overlapping abort signals. Use typed cancellation/timeout reasons or stable error classes internally and test every mapping rather than matching arbitrary strings in adapters.

### Shutdown deadlock

A shared runtime-level shutdown could cancel work owned by a replacement session or another extension. Do not add one. Owners abort their signals; the process scheduler only grants/releases permits.

### Fairness versus workflow local permits

A workflow can hold one of its local permits while waiting globally. That is acceptable because local permits are private to the run, but it must never hold a global permit while paused or waiting for a local permit.

### Configuration surprise

Applying a global cap to workflows intentionally reduces aggregate concurrency compared with the current independent limits. Document this as a correctness/resource-control change and preserve the old subagent environment variable as a fallback.

### Asset and standalone loading

Moving prompt Markdown and the Ponytail license can break source-loaded extensions or compiled embedding. Update source-path tests and run both standalone and compiled smoke checks before removing old paths.

## Acceptance criteria

The abstraction is complete when:

- both extensions use the neutral runtime for every child Pi process;
- workflows have no dependency on subagent implementation or protocol files;
- all child Pi executions share one process-wide FIFO limit while workflows retain per-run limits;
- cancellation and shutdown leave no queued permits or descendant processes;
- wire protocols, persisted sessions, workflow artifacts, tool schemas, child flags, and output semantics remain compatible;
- recursive extension loading remains disabled; and
- `bun run check` passes.

## Suggested commit sequence

1. `test(agent-runtime): characterize shared execution behavior`
2. `refactor(agent-runtime): extract neutral scheduler and runner`
3. `refactor(subagent): use shared agent execution runtime`
4. `refactor(workflow): add neutral agent executor adapter`
5. `test(agent-runtime): cover cross-extension scheduling and shutdown`
6. `docs(agent-runtime): document shared limits and architecture`

Keep the extraction and the global scheduling behavior change in separate commits so protocol/process regressions can be reviewed independently from the intentional concurrency change.
