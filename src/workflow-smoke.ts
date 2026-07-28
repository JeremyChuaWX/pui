import * as fs from "node:fs";
import * as path from "node:path";
import { createWorkflowBackend } from "../extensions/workflow/backend.js";
import { WorkflowRunManager } from "../extensions/workflow/manager.js";
import { WorkflowRunStorage } from "../extensions/workflow/run-storage.js";

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= end) throw new Error("Compiled workflow smoke timed out.");
        await Bun.sleep(10);
    }
}

/** Offline compiled-executable acceptance harness; available only with an explicit test environment. */
export async function runCompiledWorkflowSmoke(): Promise<void> {
    const root = process.env.PUI_WORKFLOW_SMOKE_ROOT;
    if (process.env.PUI_WORKFLOW_SMOKE !== "1" || !root) throw new Error("Workflow smoke harness is test-only.");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    const storage = new WorkflowRunStorage(path.join(root, "runs"));
    let deliveries = 0;
    const backend = createWorkflowBackend({
        storage,
        policy: { roles: ["explore"] },
        cooperativeExecutor: true,
        agentExecutor: async ({ prompt, signal }) => {
            if (prompt === "wait")
                return new Promise((_resolve, reject) =>
                    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
                );
            return { value: `${prompt}-done` };
        },
    });
    const manager = new WorkflowRunManager({ backend, emit: () => {}, deliver: () => deliveries++ });
    try {
        const completed = await manager.launch({
            name: "compiled-smoke",
            script: `return await parallel([agent("left",{role:"explore"}),agent("right",{role:"explore"})])`,
            sessionId: "compiled-smoke",
            cwd: project,
        });
        await waitFor(() => backend.inspect(completed.runId).run.status === "succeeded");
        await waitFor(() => deliveries === 1);
        const stopped = await manager.launch({
            name: "compiled-stop",
            script: `await agent("wait",{role:"explore"})`,
            sessionId: "compiled-smoke",
            cwd: project,
        });
        await waitFor(() => backend.inspect(stopped.runId).run.agents.length === 1);
        await manager.control(stopped.runId, "stop");
        await waitFor(() => backend.inspect(stopped.runId).run.status === "cancelled");
        const discovered = await storage.discover(project);
        process.stdout.write(
            `${JSON.stringify({ hostExecutable: process.execPath, completed: JSON.parse(backend.inspect(completed.runId).result ?? "null"), stopped: "cancelled", deliveries, recovered: discovered.some(({ id }) => id === completed.runId) })}\n`,
        );
    } finally {
        await manager.shutdown();
    }
}
