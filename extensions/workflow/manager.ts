import type { WorkflowBackend, WorkflowLaunch } from "./backend.js";
import type { WorkflowRunSummaryV1 } from "./protocol.js";

export interface WorkflowManagerOptions {
    backend: WorkflowBackend;
    emit: (run: WorkflowRunSummaryV1) => void;
    deliver: (run: WorkflowRunSummaryV1, result?: string) => void;
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
            if (terminal(run.status) && !this.delivered.has(run.id)) {
                this.delivered.add(run.id);
                let result: string | undefined;
                try {
                    result = options.backend.inspect(run.id).result;
                } catch {}
                options.deliver(run, result);
            }
        });
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
    control(id: string, action: "pause" | "resume" | "stop" | "restart-agent" | "retry") {
        return this.options.backend.control(id, action);
    }
    async shutdown(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.unsubscribe();
        await this.options.backend.shutdown();
    }
}
