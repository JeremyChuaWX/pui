import { MAX_WORKFLOW_ID, parseWorkflowRunV1, type WorkflowRunSummaryV1 } from "./protocol.js";

function workflowLaunchRunId(details: unknown): string | undefined {
    if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
    const launch = details as Record<string, unknown>;
    return launch.schema === "pi.workflow.launch" &&
        launch.version === 1 &&
        typeof launch.runId === "string" &&
        launch.runId.length > 0 &&
        launch.runId.length <= MAX_WORKFLOW_ID
        ? launch.runId
        : undefined;
}

/** Resolve tool-result details to an authoritative run: embedded v1 summaries or launch references. */
export function resolveWorkflowRun(
    details: unknown,
    workflows: readonly WorkflowRunSummaryV1[] = [],
): { run?: WorkflowRunSummaryV1; runId?: string } {
    const envelope =
        details && typeof details === "object" && !Array.isArray(details) && "run" in details
            ? (details as Record<string, unknown>)
            : undefined;
    const candidate =
        envelope?.schema === "pi.workflow" && envelope.version === 1 ? envelope.run : envelope ? undefined : details;
    const embedded = parseWorkflowRunV1(candidate);
    if (embedded) return { run: embedded, runId: embedded.id };
    const runId = workflowLaunchRunId(details);
    return { run: runId ? workflows.find((run) => run.id === runId) : undefined, runId };
}
