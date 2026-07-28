# Workflow extension (WS2 alpha)

Set `PUI_WORKFLOWS=1` before starting pui to register the `workflow` tool. Inline scripts are shown verbatim through Pi's `ctx.ui.confirm` surface and never run when confirmation is unavailable or denied. Saved names, persistence/recovery, worktrees, pause/resume, retry, and workflow UI are reserved for WS5/WS6.

The runtime is a deliberately narrow adaptation of the orchestration semantics reviewed at `pi-extensible-workflows` commit `11249e604ced3757bdd52e6c70f7282d38fb8b9f`: `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, loops/conditionals, bounded RPC, retries, timeout, and basic JSON Schema output checks. Package exports do not expose its host-neutral engine, so WS2 does **not** claim upstream parity. Durable structural identity, journals, recovery, budgets, and worktrees remain WS6 work. See ADR 0001.

## Node and security

Workers use an explicit external Node >=22.19, resolved from `PUI_WORKFLOW_NODE`, a host-configured path, then `node` on `PATH`. They use versioned bounded NDJSON—not `fork` and never `process.execPath`—with Node permission mode, a canonical worker read allowlist, and a 128 MiB old-space cap.

Scripts are untrusted. Static preflight rejects `process`, `require`, imports, `eval`, `Function`, and common network globals. The separate worker exposes only orchestration globals and JSON-safe standard values; VM string/Wasm code generation is disabled. It receives no environment and Node grants no filesystem writes, network, or child-process access. Host-side RPC validation, frame/pending bounds, agent count, timeout, process-group cancellation, and shutdown reaping are mandatory additional layers. `node:vm` alone is not treated as a security boundary.

Agent executors are trusted host code and may have broader capabilities according to host policy. Interrupted agent effects are at-least-once; exactly-once here refers only to terminal message delivery during this in-memory session.

This adaptation is original pui integration code informed by the MIT-licensed upstream engine design and ADR review; no upstream source file or Pi-TUI renderer is copied or imported.
