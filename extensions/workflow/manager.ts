import type { WorkflowBackend, WorkflowLaunch } from "./backend.js";
import type { WorkflowRunSummaryV1 } from "./protocol.js";

export interface WorkflowManagerOptions {
    backend: WorkflowBackend;
    emit: (run: WorkflowRunSummaryV1) => void;
    deliver: (run: WorkflowRunSummaryV1, result?: string) => unknown;
}
const terminal = (status: string) => status === "succeeded" || status === "failed" || status === "cancelled";

/** Session-facing lifecycle guard around a host-neutral backend. */
export class WorkflowRunManager {
    private readonly delivered = new Set<string>();
    private readonly unsubscribe: () => void;
    private shuttingDown = false;
    constructor(private readonly options: WorkflowManagerOptions) {
        this.unsubscribe = options.backend.subscribe((run) => {
            if (this.shuttingDown) return;
            options.emit(run);
            if (terminal(run.status))
                void this.deliver(run).catch((error) =>
                    console.error(
                        `Workflow terminal delivery failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                );
        });
    }
    private async deliver(run: WorkflowRunSummaryV1, recovery = false): Promise<void> {
        if (this.delivered.has(run.id)) return;
        this.delivered.add(run.id);
        let claimed = !this.options.backend.claimTerminalDelivery;
        try {
            if (this.options.backend.claimTerminalDelivery) {
                claimed = await this.options.backend.claimTerminalDelivery(run.id, { recovery });
                if (!claimed) {
                    this.delivered.delete(run.id);
                    return;
                }
            }
            let result: string | undefined;
            try {
                result = this.options.backend.inspect(run.id).result;
            } catch {}
            await this.options.deliver(run, result);
            await this.options.backend.markTerminalDelivered?.(run.id);
        } catch (error) {
            this.delivered.delete(run.id);
            if (claimed) await this.options.backend.releaseTerminalDelivery?.(run.id);
            throw error;
        }
    }
    async initialize(cwd: string): Promise<WorkflowRunSummaryV1[]> {
        const runs = (await this.options.backend.initialize?.(cwd)) ?? [];
        await Promise.all(runs.filter((run) => terminal(run.status)).map((run) => this.deliver(run, true)));
        return runs;
    }
    launch(input: WorkflowLaunch): Promise<{ runId: string }> {
        return this.options.backend.launch(input);
    }
    list(): WorkflowRunSummaryV1[] {
        return this.options.backend.list();
    }
    inspect(id: string) {
        return this.options.backend.inspect(id);
    }
    control(id: string, action: "pause" | "resume" | "stop" | "restart-agent" | "retry", agentId?: string) {
        return this.options.backend.control(id, { action, agentId });
    }
    async shutdown(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.unsubscribe();
        await this.options.backend.shutdown();
    }
}
