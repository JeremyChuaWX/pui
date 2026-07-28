# ADR 0001: Workflow runtime backend and external Node transport

- Status: accepted for WS1/WS2 planning
- Date: 2026-07-28
- Scope: WS0 only

## Decision

Use a **pinned, narrow maintained patch set** against `pi-extensible-workflows` rather than its current package unchanged or a fresh scheduler implementation. Start from upstream commit `11249e604ced3757bdd52e6c70f7282d38fb8b9f` (workspace version 3.4.2), propose the host-neutral seam below upstream, and keep the compatibility patch reviewable until it is released upstream. Do not vendor the whole Pi extension (`host.ts` and its TUI).

The patch must:

1. make the workflow worker launcher take an already-resolved external Node executable;
2. replace `fork` IPC with bounded NDJSON over `spawn` stdio for Bun-compiled hosts;
3. expose the scheduler/runtime through a small host-neutral factory;
4. retain upstream structural identities, validation, budgets, journal/replay, and worktree logic;
5. keep pui policy, approval, run presentation, and terminal delivery outside the backend.

This is not approval to start WS1+. The coordinating agent still owns that gate.

## Why

### Current upstream cannot run unchanged in compiled pui

Upstream `packages/core/src/execution.ts:402` calls:

```ts
fork(childFile, args, { execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"] })
```

It supplies no `execPath`, so Node defaults to `process.execPath`. In a Bun-compiled host that is the host executable, not Node. A compiled no-model reproduction printed:

```json
{"kind":"host","execPath":"/private/tmp/ws0-default","argv":["bun","/$bunfs/root/ws0-default"]}
```

The worker never returned. The harness cancelled after 1.5 seconds with `CANCELLED`. This substantiates recursive/wrong-host launch without allowing an unbounded process cascade.

Adding only `execPath: PUI_WORKFLOW_NODE` is insufficient. Node 26.3.0 launched the worker with upstream permission and memory flags, but `process.send()` failed with `EPIPE`; the Bun parent then reported `Workflow child exited with code 1`. The same patched runtime, launched by Node rather than compiled Bun, completed a two-agent parallel workflow. Bun-to-Node `fork` IPC is therefore not a reliable product transport on the tested platform.

### Bounded NDJSON works in the compiled host

A standalone compiled spike used `spawn(externalNode, flags)` with piped stdin/stdout, newline framing, a 64 KiB per-message bound, a 128 MiB old-space cap, Node permission mode, and an immutable temporary worker. It completed two concurrent fake agents and returned JSON-compatible structured values:

```json
{"execPath":"/private/tmp/ws0-ndjson","parallel":{"message":{"t":"result","v":{"r":[{"prompt":"left","valid":true},{"prompt":"right","valid":true}],"process":"undefined","require":"undefined","Function":"undefined","eval":"undefined"}},"beats":2,"started":["left","right"]},"cancel":{"message":{"t":"cancelled"},"started":["left","right"]}}
```

No model or network call was made. The host observed two heartbeats while work was active. Cancellation reached both in-flight fake agents and the worker reached a terminal cancelled message. Production code must additionally use the repository's detached process-group SIGTERM/SIGKILL pattern so descendants are reaped; the spike had no descendants.

Node permission mode required the worker path to be canonicalized on macOS (`/var` resolves through `/private/var`). Passing the non-canonical path failed closed with `ERR_ACCESS_DENIED`. This is a launcher requirement, not a reason to weaken flags.

## Minimum host-neutral API

The upstream proposal should be no broader than:

```ts
interface WorkflowEngineOptions {
  nodeExecutable: string; // absolute, canonical, prevalidated Node >=22.19
  storage: WorkflowStorage;
  agentExecutor: AgentExecutor;
  eventSink?: (snapshot: EngineRunSnapshot) => void;
  policy: WorkflowPolicy;
}

interface WorkflowEngine {
  launch(input: ImmutableLaunch): Promise<{ runId: string }>;
  list(): Promise<readonly EngineRunSnapshot[]>;
  inspect(runId: string): Promise<EngineRunDetails>;
  control(runId: string, action: "pause" | "resume" | "stop" | "restart-agent"): Promise<void>;
  recover(runId: string): Promise<void>;
  shutdown(): Promise<void>;
}

createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine;
```

`AgentExecutor` should be one-shot and transport-neutral: prompt/options/cwd/`AbortSignal`/progress in, structured terminal result and usage out. Ordinary agent failures are values or typed backend errors, not host UI events. Storage must be injected rather than inferred from Pi settings. Engine snapshots are authoritative backend data; WS1 defines pui's separate versioned renderer protocol.

The launcher resolves Node in the host, in this order:

1. `PUI_WORKFLOW_NODE`;
2. configured workflow Node path;
3. `node` on `PATH`.

It resolves the executable canonically, runs `node --version`, requires >=22.19.0, and returns an actionable error containing the attempted source/path/version. The worker receives no inherited `process.execArgv`.

## Required transport properties

- NDJSON in both directions, UTF-8, one JSON object per line.
- A small protocol version and message type on every frame.
- Byte bounds on partial line buffers and decoded frames before parsing; bounded pending RPC count and output values.
- Host validation of every method, option, identity, and result.
- `ready` handshake before script delivery and periodic heartbeat with a monotonic watchdog.
- Abort host operations first, request worker shutdown, then terminate the detached process group; escalate to SIGKILL after a grace period.
- Treat EOF, malformed JSON, oversized lines, unknown methods, missed heartbeat, and non-zero exit as terminal failures.
- Preserve Node's `--permission`, canonical `--allow-fs-read=<immutable-worker>`, and `--max-old-space-size=128` baseline. Add no filesystem, network, environment, or child-process permission.

## Upstream capabilities retained and evidence

Code review found useful host-independent pieces in `execution.ts`, `persistence.ts`, `budget.ts`, `validation.ts`, and `workflow-artifacts.ts`: structural operation paths, parallel/pipeline execution, RPC bounds, heartbeats, VM code-generation denial, schemas/retries, durable journals, replay, and worktree ownership. Upstream itself identifies roughly 1,666 lines as strictly portable in `notes/multi-host-portability.md` and recommends a one-shot transport-neutral agent runner.

Focused upstream no-model tests were built and run. 94/107 selected agent-execution and persistence tests passed, including structured-result repair/failure, retry/timeout/cancellation, fair scheduling, journal replay, and durable state. Thirteen failures were test-environment limitations: two omitted the upstream-required `--expose-gc`; the remainder exposed macOS `/var` versus `/private/var` canonical-path assumptions in resource/worktree fixtures. These failures are a portability risk to fix or exclude with evidence, not passing recovery acceptance. A direct Node IPC two-agent run also passed.

## Limitations and unresolved risks

- The spike used fake agent executors. It proves compiled launch, orchestration, framing, heartbeat, restrictions visible inside `vm`, structured JSON, parallelism, and cancellation—not a paid-model session or exactly-once side effects.
- Full crash recovery was not exercised through a compiled pui host. Upstream journal/replay tests passed, but WS6 must prove restart behavior end to end.
- `node:vm` is defense in depth, not the sandbox. Permission mode, process isolation, host validation, resource bounds, and process-tree cleanup remain mandatory.
- The 64 KiB spike frame cap only demonstrates bounding. Product limits must be selected consistently with workflow output retention; upstream currently permits 10 MiB RPC values.
- Windows process-tree termination and Node permission-path behavior were not tested.
- Upstream 3.4.2 peers Pi 0.80.9 while pui uses 0.80.10, and its public package exports Pi extension entry points rather than an engine factory. Pinning and the narrow patch are required until upstream publishes a compatible API.
- The upstream checkout reported two npm audit findings (one moderate, one high). Dependency provenance and audit disposition are required before WS2 integration.

## Rejected alternatives

- **Use upstream unchanged:** rejected by recursive compiled launch, Bun/Node IPC failure, and missing host-neutral lifecycle API.
- **Only add `fork(..., { execPath })`:** rejected by reproduced `EPIPE` under compiled Bun.
- **Rewrite the scheduler in pui:** rejected because upstream already has the difficult deterministic identity, replay, budget, retry, and worktree semantics.
- **Vendor the complete core now:** rejected as a larger audit/update burden while a narrow upstreamable seam is plausible. Reconsider audited vendoring only if upstream declines the factory/launcher changes or the patch ceases to remain narrow.
