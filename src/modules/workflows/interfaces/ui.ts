/**
 * UI Entry: the parsed workflow state the TUI consumes. The bridge owns
 * background-event subscription, instance authority, and control round-trips;
 * the view model resolves extension-owned tool-result details against
 * authoritative runs so views never parse feature wire formats themselves.
 */
export {
    reduceWorkflowEvent,
    WorkflowBridge,
    type WorkflowBridgeOptions,
    type WorkflowControlAction,
    type WorkflowRunSummaryV1,
    type WorkflowState,
} from "../bridge.js";
export type { WorkflowAgentStatus, WorkflowRunStatus } from "../protocol.js";
export { resolveWorkflowRun } from "../view-model.js";
