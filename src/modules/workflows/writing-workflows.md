# Writing pui workflows

Create workflow files as `.ts` modules. A file must default-export one **named async function**; pui calls it with a frozen `WorkflowContext` and the JSON-compatible `args` supplied at launch.

```ts
import type { WorkflowContext, WorkflowMetadata } from "pui/workflow";

type Args = { target: string };

export const meta = {
    name: "review-target",
    description: "Review a target and run its tests",
} satisfies WorkflowMetadata;

export default async function reviewTarget(context: WorkflowContext, args: Args) {
    await context.phase("review");
    const review = await context.agent(`Review ${args.target}`, { role: "explore" });
    const tests = await context.shell("bun test", { timeoutMs: 120_000 });
    return { review, tests };
}
```

The context provides:

- `agent(prompt, options?)` to run an agent. Options include `label`, `role`, `model`, `schema`, `retries`, `timeoutMs`, and `isolation: "worktree"`.
- `shell(command, options?)` to run a command in the workflow cwd. It returns `{ exitCode, stdout, stderr }`; a nonzero exit is a normal result. Options are `timeoutMs` and string-valued `env` overrides.
- `parallel(arrayOrObject)` to await independent work concurrently.
- `pipeline(items, operation, { concurrency? })` to map work with bounded concurrency.
- `phase(name)` to mark progress and `log(value)` to report progress.

Metadata is optional; without it, the display name comes from the filename. Only the type-only import from `pui/workflow` is supported. Runtime imports and syntax requiring transformation (including TSX, enums, runtime namespaces, and decorators) are not supported because workflows use Node's strip-only TypeScript execution and are not typechecked.

Prefer explicit context methods over ambient APIs. Workflow code cannot directly access the filesystem, environment, network, child processes, or signals; use the approved `shell()` capability when a command is necessary. Concurrent write-capable agents require `isolation: "worktree"`, and worktree branches are never merged automatically.

Run a file interactively with `/workflow <path> [JSON args]`, or headlessly with `pui workflow [--cwd <project>] <path> [JSON args]`. Paths are explicit: pui does not discover or save named workflows. Exact source requires approval, and changed or moved files require approval again.
