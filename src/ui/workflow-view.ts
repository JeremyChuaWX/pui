import type {
    WorkflowAgentStatus,
    WorkflowRunStatus,
    WorkflowRunSummaryV1,
} from "../../extensions/workflow/protocol.js";

const WORKFLOW_STATUS_PRESENTATION: Record<WorkflowRunStatus | WorkflowAgentStatus, { icon: string; label: string }> = {
    queued: { icon: "·", label: "Queued" },
    running: { icon: "◌", label: "Running" },
    paused: { icon: "Ⅱ", label: "Paused" },
    succeeded: { icon: "✓", label: "Succeeded" },
    failed: { icon: "×", label: "Failed" },
    cancelled: { icon: "■", label: "Stopped" },
    timed_out: { icon: "×", label: "Timed out" },
};

export function workflowStatusPresentation(status: WorkflowRunStatus | WorkflowAgentStatus) {
    return WORKFLOW_STATUS_PRESENTATION[status];
}

export function workflowStatusTone(
    status: WorkflowRunStatus | WorkflowAgentStatus,
): "success" | "error" | "warning" | "muted" | "info" {
    if (status === "succeeded") return "success";
    if (status === "failed" || status === "timed_out") return "error";
    if (status === "running" || status === "paused") return "warning";
    return status === "queued" || status === "cancelled" ? "muted" : "info";
}

export function formatWorkflowSummary(run: WorkflowRunSummaryV1): string {
    const state = workflowStatusPresentation(run.status);
    const done = run.agents.filter((agent) =>
        ["succeeded", "failed", "cancelled", "timed_out"].includes(agent.status),
    ).length;
    return `${state.icon} ${run.name} · ${state.label} · ${done}/${run.agents.length} agents${run.currentPhase ? ` · ${run.currentPhase}` : ""}`;
}
