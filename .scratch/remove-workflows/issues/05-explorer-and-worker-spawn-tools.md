# 05 — `explorer` and `worker` spawn tools with Profile directories

**Parent:** issues/0002-remove-workflows.md

**What to build:** The Pi model spawns a Job by calling `explorer` or `worker`; each returns a Job id immediately and queues behind the process-wide semaphore. `subagent_spawn`, its `agent` argument, the `generic` role, and `subagent_list` are gone. Each Profile is a directory holding its declaration and `prompt.md`, a shared profile type carries default Limits and the child argument list, and one index lists what gets registered. Tool descriptions tell the model each Profile's tools, default model, and Limits.

**Blocked by:** 04 — Fold the Child-Agent Runtime and single-consumer shared files into subagents.

**Status:** ready-for-agent

- [ ] `explorer` runs with tools `read`, `grep`, `find`, `ls` and replaces the system prompt with its `prompt.md`
- [ ] `worker` runs with tools `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and appends its `prompt.md` (Ponytail guidance, license preserved)
- [ ] Default models are `openrouter/z-ai/glm-5.3-flash:low` (explorer) and `openrouter/z-ai/glm-5.3-flash:high` (worker); an explicit `model` argument wins, then `PI_EXPLORER_MODEL` / `PI_WORKER_MODEL`, then the default
- [ ] Children still run with sessions, extensions, skills, prompt templates, and context files disabled
- [ ] Relative `cwd`, `~`, and a stray leading `@` are normalised as before
- [ ] `subagent_spawn`, `subagent_list`, and every reference to a `generic` role are removed; `subagent_check`, `subagent_wait`, `subagent_cancel`, and the blocking `subagent` tool still work (the blocking tool is removed in ticket 06)
- [ ] Extension-seam tests cover both Profiles' child arguments, model resolution order, and the registered tool list
- [ ] The Register File test and the `--smoke` expectations list the new tool names
- [ ] `bun run check` is green
