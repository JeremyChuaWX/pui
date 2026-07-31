# Workflow extension

pui registers the bundled `workflow` tool by default. The tool accepts exactly one source: inline TypeScript (or its JavaScript subset) in `script`, or an explicit canonical `.ts` workflow file in `path`. `/workflow <path> [JSON args]` launches a `.ts` file directly, resolving relative paths from the current working directory; wrap paths containing spaces in single or double quotes. pui does not discover or save named definitions in fixed project or personal directories.

For automation, `pui workflow [--cwd <project>] <path> [JSON args]` runs a file without opening the TUI or creating a Pi session. JSON args are optional. Progress is printed to stderr while stdout remains reserved for the final JSON result. Supplying the path on this command line explicitly authorizes the file for that invocation, bypassing UI approval and project-trust prompts. Runtime sandboxing, host policy, durable storage, external-Node resolution, and worktree isolation are unchanged; failures return a nonzero exit. Headless runs are not delivered, recovered, or continued by a later TUI session.

Workflow files are TypeScript modules with exactly one named, default-exported async function. pui invokes it as `workflow(context, args)`. The frozen context explicitly provides `agent`, `shell`, `pipeline`, `parallel`, `phase`, and `log`; those capabilities are not ambient globals in file workflows. Inline scripts retain the existing globals and top-level `args` convenience.

```ts
import type { WorkflowContext, WorkflowMetadata } from "pui/workflow";

type ReviewArgs = { topic: string };

export const meta = {
    name: "review-topic",
    description: "Review one topic",
} satisfies WorkflowMetadata;

export default async function reviewTopic(context: WorkflowContext, args: ReviewArgs) {
    const review = await context.agent(`Review ${args.topic}`, { role: "explore" });
    const tests = await context.shell("bun test", { timeoutMs: 120_000 });
    return { review, tests };
}
```

`shell(command, options?)` runs a platform-shell command directly in the workflow cwd without starting an agent. It returns `{ exitCode, stdout, stderr }`; nonzero exits are normal results. Options support `timeoutMs` and string-valued `env` overrides. Completed shell results are journaled for retry and recovery. If the host is interrupted after a command causes side effects but before its result is durable, recovery can run it again.

Workflow TypeScript uses Node's built-in strip-only execution. It is not typechecked and does not read `tsconfig`. The optional `import type { ... } from "pui/workflow"` declaration is removed before execution; runtime imports and all other imports are forbidden. TSX, enums, runtime namespaces, decorators, and other syntax requiring transformation rather than type stripping are unsupported.

A file may optionally declare static `export const meta = { name: "...", description: "..." }` metadata; otherwise its display name falls back to the file's basename. Inline metadata is also optional and otherwise uses the inline-workflow fallback name. Exact workflow source is shown in an inline transcript approval block; use **PageUp**/**PageDown** to inspect long scripts. Accepting the approval immediately runs the workflow and trusts that exact source in the project. Approval applies to the canonical path, exact source bytes, and host-capability version, so moving or changing a file—or upgrading to a newly exposed host capability—requires approval again. A file that resolves inside the current repository additionally requires Pi project trust. Scripts never run when confirmation is unavailable or denied.

Durable run artifacts live outside projects under `~/.pi/agent/workflow-runs/<project-hash>/<run-id>/`; injected `WorkflowRunStorage` roots keep recovery tests hermetic. Launch bytes and policy are immutable, snapshots are atomic, completion journals are append-only and fsynced, and corrupt/truncated or symlinked artifacts fail closed.

Completed JSON-compatible agent and shell operations replay from their structural identity. An operation active when the host is interrupted is not journaled and runs again after explicit recovery. Consequently interrupted model/command/tool/filesystem effects are **at least once**, not exactly once. Recovery must remain user-selected (ask by default); worktree branches are never merged automatically.

The runtime is a narrow, host-neutral implementation informed by the orchestration semantics reviewed at `pi-extensible-workflows` commit `11249e604ced3757bdd52e6c70f7282d38fb8b9f`: `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, loops/conditionals, bounded RPC, retries, timeouts, JSON Schema checks, durable structural identities and journals, explicit recovery, budgets, and isolated worktrees. It does not claim package-level upstream parity; see ADR 0001 for the implementation decision and evidence.

## Node and security

Workers use an explicit external Node >=22.19, resolved from `PUI_WORKFLOW_NODE`, a host-configured path, then `node` on `PATH`. They use versioned bounded NDJSON—not `fork` and never `process.execPath`—with Node permission mode, a canonical worker read allowlist, and a 128 MiB old-space cap.

Scripts are untrusted. Static preflight rejects `process`, `require`, imports, `eval`, `Function`, and common network globals. The separate worker exposes only orchestration globals and JSON-safe standard values; VM string/Wasm code generation is disabled. It receives no environment and Node grants no filesystem writes, network, or child-process access. The approved `shell()` RPC is the explicit exception: the trusted host executes the command with the host environment plus declared overrides, bounds combined output to 128 KiB, enforces timeout/cancellation, and reaps its process group. Host-side RPC validation, frame/pending bounds, agent count, timeout, process-group cancellation, and shutdown reaping are mandatory additional layers. `node:vm` alone is not treated as a security boundary.

Agent and shell executors are trusted host code and may have broader capabilities according to host policy. Interrupted agent effects are at-least-once. Terminal delivery is claimed and marked in durable run storage, suppressing duplicates during ordinary recovery and within one session. A crash between the external message send and recording delivery leaves an unavoidable duplicate-versus-loss window, so strict exactly-once delivery is not promised across that send.

File paths are always explicit inputs rather than discovered definitions. The host reads a requested file, while the untrusted workflow process retains no direct filesystem access. `/workflows` provides durable-run inspection, recovery, and controls. Worktree branches are retained and never merged automatically.

This adaptation is original pui integration code informed by the MIT-licensed upstream engine design and ADR review; no upstream source file or Pi-TUI renderer is copied or imported.
