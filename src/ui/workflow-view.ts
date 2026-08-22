import type {
    WorkflowAgentStatus,
    WorkflowRunStatus,
    WorkflowRunSummaryV1,
} from "../../modules/workflows/interfaces/ui.js";

export const WORKFLOW_NAVIGATION_TIMEOUT_MS = 30_000;

export interface PendingWorkflowNavigation {
    /** Runs that already existed when navigation was requested. */
    ids: ReadonlySet<string>;
    requestedAt: number;
    sessionId: string;
}

export type WorkflowNavigationResolution =
    | { kind: "expire" }
    | { kind: "navigate"; runId: string }
    | { kind: "wait"; recheckInMs: number };

/**
 * Route a pending workflow-page navigation: expire when the session changed or the
 * request timed out, navigate to the most recently updated new run, otherwise wait
 * for the remainder of the timeout window.
 */
export function resolveWorkflowNavigation(
    pending: PendingWorkflowNavigation,
    snapshot: { sessionId: string; workflows: readonly WorkflowRunSummaryV1[] },
    now: number,
): WorkflowNavigationResolution {
    if (pending.sessionId !== snapshot.sessionId || now - pending.requestedAt >= WORKFLOW_NAVIGATION_TIMEOUT_MS)
        return { kind: "expire" };
    const run = snapshot.workflows
        .filter((candidate) => !pending.ids.has(candidate.id) && candidate.updatedAt >= pending.requestedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (run) return { kind: "navigate", runId: run.id };
    return { kind: "wait", recheckInMs: WORKFLOW_NAVIGATION_TIMEOUT_MS - (now - pending.requestedAt) };
}

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
