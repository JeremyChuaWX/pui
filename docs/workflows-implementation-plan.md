# Programmatic Workflows Implementation Plan

Status: implemented alpha, opt-in behind `PUI_WORKFLOWS=1`; manual acceptance and default-enable criteria remain pending

This document is an implementation plan for adding Claude Code-style dynamic workflows to pui. It is organized so an orchestrating agent can delegate bounded work packages to subagents without assigning overlapping files.

## Goal

Add a first-class workflow system in which Pi can write or load a JavaScript orchestration script, ask the user to approve it, and run it in the background while pui remains responsive.

The script, rather than the parent model, owns loops, branching, fan-out, aggregation, and phase transitions. Agent prompts and intermediate results stay in the workflow runtime instead of filling the parent conversation. pui owns the approval, progress, inspection, and control experience.

The target combines:

- Claude Code Dynamic Workflows: generated JavaScript, background execution, raw-script approval, `/workflows`, saved workflows, bounded concurrency, and orchestration-only scripts.
- `pi-extensible-workflows`: structured output, deterministic operation identities, journaling, recovery, retries, budgets, checkpoints, roles, and worktrees.
- pui's bundled subagent patterns: versioned renderer-neutral state, bounded output, session-scoped events, cancellation, generic rendering fallback, and native OpenTUI cards.

## Terminology

- **Workflow definition**: a saved JavaScript file with metadata and an orchestration body.
- **Run**: one immutable launch of a workflow definition with arguments and policy.
- **Operation**: one structurally identified agent, phase, checkpoint, or future shell call.
- **Worker**: the restricted external Node process that evaluates orchestration JavaScript.
- **Host**: the trusted pui/Pi extension process that executes agent and worktree operations.
- **Backend**: the host-neutral engine behind pui's workflow extension.

This feature implements dynamic workflows, not Anthropic API programmatic tool calling. The latter runs model-generated Python in Anthropic's code-execution container and has a different protocol and trust boundary.

## Product requirements

### Required for the first usable release

1. Pi can generate an inline JavaScript workflow and launch it through a tool.
2. Users can inspect and approve the exact script before it starts.
3. Runs execute in the background and do not block normal pui interaction.
4. Scripts support `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, normal loops, and conditionals.
5. Agent results can be validated against JSON Schema.
6. pui displays live run, phase, agent, usage, and failure state.
7. `/workflows` lists runs and supports inspect, pause, resume, stop, retry, and save.
8. Project and personal workflow definitions can be rerun without regenerating their orchestration.
9. The compiled pui executable launches a real Node worker and never recursively launches itself.
10. Every run is bounded by concurrency, agent-count, timeout, memory, and message-size limits.

### Required before workflows are enabled by default

1. A versioned protocol with unknown-version fallback.
2. Durable run snapshots and journaled completed operations.
3. Recovery after pui exits or crashes.
4. Exactly one terminal result delivery per run.
5. Worktree isolation for concurrent write-capable agents.
6. Clear project-trust and generated-script approval boundaries.
7. Compiled-binary, cancellation, recovery, and malicious-script smoke tests.

### Deferred

- A graphical DAG editor or YAML DSL.
- Automatic `ultracode`-style triggering for every substantive prompt.
- Direct filesystem or network access from workflow JavaScript.
- Unrestricted `shell()` calls from workflow JavaScript.
- Agent teams or peer-to-peer agent messaging.
- Automatic merging of all worktree branches.
- A promise of exactly-once filesystem side effects.

## Public workflow API

The initial public surface should be deliberately small:

```js
export const meta = {
  name: "review-changes",
  description: "Review changed files and synthesize verified findings",
};

phase("discover");

const { files } = await agent("List files changed relative to main.", {
  role: "explore",
  schema: {
    type: "object",
    required: ["files"],
    properties: {
      files: { type: "array", items: { type: "string" } },
    },
  },
});

phase("review");

const reviews = await pipeline(
  files,
  (file) =>
    agent(`Review ${file} for correctness and security issues.`, {
      role: "explore",
      label: file,
    }),
  { concurrency: 4 },
);

phase("synthesize");

return agent(
  `Verify, deduplicate, and rank these findings:\n${JSON.stringify(reviews)}`,
  { role: "worker", label: "Final report" },
);
```

### Globals

- `agent(prompt, options?)`
- `pipeline(items, callback, options?)`
- `parallel(arrayOrRecord)`
- `phase(name)`
- `log(message)`
- `args`

### `agent` options

- `label?: string`
- `role?: "generic" | "worker" | "explore" | string`
- `model?: string`
- `schema?: JsonSchema`
- `retries?: number`
- `timeoutMs?: number`
- `isolation?: "worktree"`

### Follow-up surface

Add only after the base runtime is stable:

- `checkpoint(name, context?)`
- `withWorktree(name, callback)`
- permissioned `shell(command, options?)`
- registered workflow functions and variables
- bounded nested workflow invocation

## Security and policy

Generated JavaScript is untrusted even when the extension is trusted.

The worker must:

- run in a separate external Node process;
- use Node's permission flags and a memory cap;
- receive the script over a bounded channel or execute an immutable copied script;
- expose no `process`, `require`, imports, dynamic import, `eval`, `Function`, filesystem, network, environment, or child-process access;
- send only bounded JSON-compatible values;
- emit heartbeats and be terminated when unresponsive;
- be killed with all child work when a run is stopped.

`node:vm` alone is not a security boundary. Static analysis and a stripped VM context are defense in depth around process isolation and host-side policy.

The host must:

- validate every RPC request independently of worker validation;
- intersect requested roles, models, and tools with host policy;
- reject unknown methods and oversized values;
- enforce concurrency, count, timeout, token, and cost limits;
- require project trust before running project workflows;
- require worktrees for concurrent write-capable agents unless the user explicitly approves unsafe shared-checkout execution;
- never treat a tool allowlist as an OS sandbox;
- document that interrupted agent and future shell effects are at-least-once.

Initial defaults:

| Setting | Default |
| --- | --- |
| Concurrent agents | 4 |
| Configurable concurrency ceiling | 16 |
| Large-run warning | 25 scheduled agents |
| Hard agent cap | 1,000 |
| Direct workflow shell | disabled |
| Launch approval | required |
| Resume after restart | ask |

Approval trust should be keyed by the canonical project path, workflow name, and SHA-256 of the exact script. A changed script requires approval again.

## Architecture

```text
Main Pi agent
    │ writes script and invokes workflow
    ▼
Bundled pui workflow extension
    ├── static preflight and launch policy
    ├── approval request
    ├── run manager and terminal delivery
    └── versioned snapshot/control events
              │
              ▼
Host-neutral workflow backend
    ├── scheduler and structural identities
    ├── journal and recovery
    ├── budgets and worktree ownership
    └── external Node worker transport
              │
              ├── restricted JavaScript worker
              │
              └── isolated Pi agent sessions
                          │
                          ▼
src/workflow.ts → PuiController → PuiSnapshot → OpenTUI
```

### Ownership boundary

pui owns:

- workflow policy and feature settings;
- renderer-neutral protocol;
- approval and management UI;
- saved-workflow discovery and commands;
- controller reduction and session routing;
- generic Pi tool/custom-message fallback.

The backend owns:

- script instrumentation and execution;
- operation identity and scheduling;
- agent execution and structured result validation;
- journal, snapshot, retry, and recovery semantics;
- worktree ownership and budgets.

### Backend decision gate

Do not independently rewrite the `pi-extensible-workflows` scheduler before completing the runtime spike.

Preferred path:

1. Add a host-neutral factory to `pi-extensible-workflows`, conceptually:

   ```ts
   createWorkflowEngine({
     nodeExecutable,
     storage,
     agentExecutor,
     eventSink,
     policy,
   });
   ```

2. Make its worker launcher accept an explicit Node executable.
3. Add a stable versioned list/snapshot/control contract.
4. Have pui's bundled extension use that library API rather than the upstream Pi-TUI extension entry point.

For the spike, use a pinned fork. If the host-neutral API cannot be upstreamed, choose between a narrow maintained patch set and a pinned audited vendored core. Record that decision in an ADR before product implementation continues.

## Runtime compatibility gate

The current upstream implementation uses `child_process.fork()` without an explicit `execPath`. In a Bun-compiled pui binary, `process.execPath` points to pui rather than Node. The implementation must not ship until this is fixed.

Resolution order:

1. `PUI_WORKFLOW_NODE`
2. configured workflow Node path
3. `node` on `PATH`

Validate Node >=22.19 and return an actionable error when it is unavailable.

The spike must verify whether Bun-to-Node IPC with `fork(..., { execPath })` is reliable in the compiled binary. If it is not, use a bounded NDJSON protocol over `spawn()` stdio. Do not weaken worker permission flags to force it to execute under Bun.

## Protocol

Follow `extensions/subagent/protocol.ts` and `extensions/subagent/background-protocol.ts` rather than exposing backend internals.

Proposed summary shape:

```ts
interface WorkflowRunSummaryV1 {
  schema: "pi.workflow";
  version: 1;
  id: string;
  name: string;
  sessionId: string;
  cwd: string;
  status:
    | "awaiting_approval"
    | "queued"
    | "running"
    | "paused"
    | "succeeded"
    | "failed"
    | "cancelled";
  currentPhase?: string;
  phases: WorkflowPhaseSummaryV1[];
  usage: WorkflowUsageV1;
  limits: WorkflowLimitsV1;
  startedAt?: number;
  updatedAt: number;
  endedAt?: number;
  warning?: string;
  error?: string;
}
```

Protocol requirements:

- explicit schema and version;
- exact `sessionId`, `instanceId`, and canonical `cwd` routing;
- `ready`, `reset`, `upsert`, and `remove` snapshot events;
- separate validated control messages;
- bounded phase, agent, activity, prompt, output, and diagnostic fields;
- authoritative snapshots rather than an event stream that requires perfect delta delivery;
- unknown or malformed versions fall back to generic tool cards;
- full details are queried through a host API, never by parsing journal files.

The controller owns only presentation state. The backend remains the source of truth and re-emits current snapshots after every session bind.

## Persistence

Saved definitions:

```text
.pi/workflows/*.js
~/.pi/agent/workflows/*.js
```

Run artifacts:

```text
~/.pi/agent/workflow-runs/<project-hash>/<run-id>/
  workflow.js
  args.json
  snapshot.json
  journal.jsonl
  result.json
  summary.json
```

Rules:

- The exact script, arguments, policies, roles, models, and limits are immutable for one run.
- Script changes create a new run.
- Completed operations replay cached JSON-compatible results.
- An operation active at interruption restarts.
- Terminal custom-message delivery is idempotent.
- Project workflow lookup walks from cwd toward the repository root; the closest definition wins, then the personal definition.
- Saving refuses unsafe symlink traversal.
- Run artifacts are private and must not dirty the project worktree.

## User experience

### Launch

The model-facing `workflow` tool accepts an inline script or saved workflow name and structured arguments. Inline launches perform static preflight and emit an approval request.

The approval dialog shows:

- name and description;
- phases discovered by preflight;
- visible agent calls and requested roles/models;
- concurrency and budgets;
- the exact raw JavaScript;
- **Run once**, **Trust unchanged script in this project**, **Edit**, and **Deny**.

The tool returns a run ID after background launch. Completion arrives as exactly one custom result message so normal Pi clients retain a useful fallback.

### Progress

Add:

- a live workflow tool card;
- an active-runs section in the sidebar;
- a `/workflows` local command and command-palette entry;
- run → phase → agent navigation;
- prompt, recent tools, result, usage, and error inspection;
- open-script and open-artifact actions.

Controls:

- **Pause**: active agents may finish; no new operations start.
- **Resume**: scheduling continues.
- **Stop**: abort worker and all active agents.
- **Restart agent**: abort and rerun the selected operation.
- **Retry run**: create a linked replay run from a failed run.
- **Save**: persist the immutable script as a project or personal workflow.

Do not persist complete intermediate transcripts in the parent session JSONL.

## Repository changes

Expected new files:

```text
docs/workflows-implementation-plan.md
extensions/workflow/README.md
extensions/workflow/index.ts
extensions/workflow/backend.ts
extensions/workflow/manager.ts
extensions/workflow/protocol.ts
extensions/workflow/background-protocol.ts
extensions/workflow/storage.ts
extensions/workflow/*.test.ts
src/workflow.ts
src/workflow.test.ts
```

Expected modified files:

```text
package.json
bun.lock
src/bundled-extensions.ts
src/controller.ts
src/types.ts
src/format.ts
src/app.tsx
README.md
scripts/smoke-build.ts
```

Do not place backend execution state in `src/controller.ts` or UI state in the extension manager.

## Subagent execution plan

### General delegation rules

The coordinating agent must:

1. Create one worktree or isolated branch per implementation subagent.
2. Assign files according to the ownership table below.
3. Avoid concurrent edits to `src/controller.ts`, `src/app.tsx`, `src/format.ts`, `package.json`, `bun.lock`, or `README.md`.
4. Require each subagent to read `CONTRIBUTION.md` and all directly relevant existing subagent files before editing.
5. Require targeted tests and a concise handoff containing changed files, commands run, unresolved risks, and the commit hash.
6. Integrate work in dependency order and resolve conflicts in the coordinating branch, not in parallel worker branches.
7. Use conventional commits.
8. Run `bun run check` on the integrated branch before completion.

Subagents should make the smallest coherent change for their work package. They must not opportunistically redesign unrelated pui systems.

### Dependency graph

```text
WS0 runtime spike and ADR
        │
        ├── WS1 protocol
        │       │
        │       ├── WS3 controller adapter
        │       │       │
        │       │       └── WS4 OpenTUI UI
        │       │
        │       └── WS2 extension/backend adapter
        │               │
        │               ├── WS5 saved definitions
        │               └── WS6 durable recovery/worktrees
        │
        └──────────────────── WS7 hardening, docs, and full checks
```

WS1 and the backend-only portion of WS2 may run in parallel after WS0 if they do not share files. WS3 and WS4 are sequential. WS5 and WS6 should be sequential unless split into non-overlapping backend modules.

### Workstream ownership

| Workstream | Purpose | Exclusive files during work | Depends on |
| --- | --- | --- | --- |
| WS0 | Runtime spike and backend ADR | spike branch, upstream fork, new ADR/report only | none |
| WS1 | Versioned protocols and parsers | `extensions/workflow/protocol.ts`, `background-protocol.ts`, `src/workflow.ts`, matching tests | WS0 contract |
| WS2 | Bundled extension and backend adapter | remaining `extensions/workflow/`, `src/bundled-extensions.ts`; dependency files only after coordination | WS0, protocol types |
| WS3 | Controller state and controls | `src/controller.ts`, `src/types.ts`, controller tests | WS1, WS2 events |
| WS4 | Cards, sidebar, dialogs, navigator | `src/app.tsx`, `src/format.ts`, presentation tests | WS3 |
| WS5 | Saved definition discovery and commands | `extensions/workflow/storage.ts`, command-specific extension files | WS2 |
| WS6 | Journal recovery, budgets, worktrees | backend adapter modules and recovery tests | WS2, then WS5 |
| WS7 | Security, compiled smoke, docs, release checks | `scripts/smoke-build.ts`, `README.md`, focused hardening tests | all prior work |

### WS0: runtime spike and ADR

Tasks:

- Reproduce the compiled Bun `process.execPath` failure with the upstream worker.
- Add an explicit external Node launcher in a spike fork.
- Test IPC, cancellation, heartbeat, permission flags, structured output, parallel agents, and recovery.
- Test source pui and the compiled executable.
- Propose the minimum host-neutral upstream API.
- Decide upstream dependency, narrow patch set, or audited vendoring.
- Record the decision and evidence in an ADR or spike report.

Exit criteria:

- No recursive pui launch.
- Node version failures are explicit.
- Stop terminates worker and active agents.
- A two-agent workflow completes in the compiled binary.
- The coordinating agent approves the backend decision before WS2 begins.

### WS1: protocol and parser

Tasks:

- Define bounded workflow run, phase, agent, usage, limits, event, and control v1 types.
- Implement defensive parsers and immutable reducers.
- Include `sessionId`, `instanceId`, and cwd validation.
- Cover malformed, oversized, stale, and unknown-version data.
- Match the generic fallback behavior of the subagent protocol.

Exit criteria:

- Protocol tests require no live workflow engine.
- Unknown versions never crash rendering.
- Snapshots are bounded for a 1,000-agent synthetic run.
- Control parsing rejects wrong sessions, instances, actions, and IDs.

### WS2: extension and backend adapter

Tasks:

- Register the model-facing workflow tool.
- Implement backend launch, list, inspect, subscribe, and control adapters.
- Implement run manager lifecycle and exactly-once terminal delivery.
- Emit protocol snapshots through `pi.events`.
- Wire the bundled extension without importing Pi-TUI renderers.
- Add the workflow feature flag.

Exit criteria:

- A fake backend fully exercises the extension manager.
- A real backend launches one background workflow.
- Non-pui Pi receives a useful generic tool result and terminal message.
- Session shutdown cannot strand untracked workers.

### WS3: controller integration

Tasks:

- Subscribe and unsubscribe during every session bind.
- Reduce workflow events into `PuiSnapshot`.
- Expose typed inspect and control methods.
- Ignore stale extension instances and wrong-session events.
- Restore current summaries after a session replacement.

Exit criteria:

- Controller tests cover bind, rebind, reset, stale events, controls, and disposal.
- The controller never reads workflow artifact files.
- Existing subagent and tool-execution behavior is unchanged.

### WS4: OpenTUI presentation

Tasks:

- Add workflow display variants and formatting.
- Add collapsed and expanded workflow cards.
- Add active workflows to the sidebar.
- Add approval, list, run detail, phase detail, and agent detail dialogs.
- Add pause, resume, stop, restart, retry, save, and editor actions.
- Add `/workflows` and command-palette integration.

Exit criteria:

- Large run summaries remain responsive.
- Prompts and outputs are bounded and expandable.
- Every destructive action requires explicit confirmation.
- Unknown protocol data remains a generic card.
- Existing narrow terminal layouts remain usable.

### WS5: saved workflows

Tasks:

- Discover project and personal workflow files with deterministic precedence.
- Validate metadata without executing scripts.
- Implement save with symlink and containment checks.
- Add direct invocation and structured arguments.
- Add saved definitions to autocomplete.
- Invalidate approval when the script hash changes.

Exit criteria:

- Nearest project definition wins over repository-root and personal definitions.
- Save cannot traverse through unsafe symlinks.
- A saved workflow runs without model-regenerated orchestration.
- Name collisions and invalid metadata produce actionable errors.

### WS6: durable recovery and isolation

Tasks:

- Persist immutable launch snapshots and append-only completion journal entries.
- Replay completed structural operation paths.
- Restart operations that were active at interruption.
- Make terminal delivery idempotent.
- Add worktree references and require isolation for concurrent writers.
- Add token, cost, duration, retry, and agent-count budget handling.
- Add startup recovery discovery and ask/inspect/stop/resume actions.

Exit criteria:

- Killing pui after partial completion does not rerun completed read-only operations.
- An interrupted active operation reruns once on recovery.
- Changed source starts a new run rather than mutating old state.
- Concurrent write agents cannot silently share a checkout.
- Recovery corruption fails closed with inspectable diagnostics.

### WS7: hardening and release

Tasks:

- Add malicious-script and host-RPC validation tests.
- Extend compiled smoke tests for worker launch, missing Node, stop, and terminal delivery.
- Test process-tree cleanup on cancellation and pui shutdown.
- Document installation, Node requirements, trust boundary, workflow paths, controls, and troubleshooting.
- Update the main README only after behavior is final.
- Run the full contribution checks.

Exit criteria:

- `bun run check` passes.
- Security boundary and at-least-once caveat are documented.
- Feature remains opt-in until all default-enable requirements pass.
- No test requires paid model calls.

## Required test scenarios

### Pure runtime

- sequential `agent` calls;
- keyed and array parallel calls;
- bounded pipelines;
- loops and conditional branches;
- stable structural operation identity;
- valid, repaired, and invalid structured output;
- retries and timeout;
- cancellation while agents are active;
- runaway workflow and heartbeat failure;
- worker memory and RPC limits;
- attempts to access process, imports, environment, filesystem, network, or dynamic evaluation.

### Host and protocol

- session and cwd isolation;
- stale instance rejection;
- exactly-once terminal message delivery;
- approval hash invalidation;
- role/model/tool policy intersection;
- queue fairness and global concurrency;
- malformed and unknown protocol versions;
- output truncation and private retained artifacts;
- symlink-safe discovery and save.

### Product acceptance

1. Review every changed file and synthesize one ranked report.
2. Audit route handlers and adversarially verify every finding.
3. Repeatedly fix type errors until checks pass or progress stops.
4. Produce several independent plans and synthesize one recommendation.
5. Modify independent files in isolated worktrees.
6. Stop after partial completion and resume without rerunning completed operations.
7. Save a successful generated script and invoke it directly in another session.

## Merge and release sequence

1. Merge WS0 documentation and upstream compatibility work.
2. Merge WS1 protocol with no user-visible behavior.
3. Merge WS2 behind `PUI_WORKFLOWS=1`.
4. Merge WS3 and WS4 to make alpha runs observable and controllable.
5. Merge WS5 for reusable workflows.
6. Merge WS6 for durable, write-capable workflows.
7. Merge WS7 hardening and documentation.
8. Run a manual alpha on representative read-only and write-capable workflows.
9. Enable by default only after compiled, security, recovery, and worktree acceptance criteria pass.

Every merge must preserve `bun run check`. If a workstream changes a protocol or backend contract, downstream subagents must be stopped and rebased onto the revised contract before continuing.

## Sources

External documentation and the video transcript were reviewed with web search and Firecrawl extraction:

- [Claude Code Dynamic Workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code programmatic/headless operation](https://code.claude.com/docs/en/headless)
- [Subagents in the Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Anthropic programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- [pi-extensible-workflows video](https://www.youtube.com/watch?v=qAiivspEHmU)
- [pi-extensible-workflows repository](https://github.com/vekexasia/pi-extensible-workflows)
- [Host-neutral runtime issue](https://github.com/vekexasia/pi-extensible-workflows/issues/160)
