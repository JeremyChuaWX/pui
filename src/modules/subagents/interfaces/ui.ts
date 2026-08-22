/**
 * UI Entry: the parsed subagent state the TUI consumes. The view model
 * validates extension-owned wire payloads and bounds every string for
 * rendering; the background bridge owns event subscription, instance
 * authority, and cancellation routing.
 */
export {
    BackgroundSubagentBridge,
    type BackgroundSubagentState,
    type BackgroundSubagentViewModel,
    parseBackgroundSubagentEvent,
    reduceBackgroundSubagentEvent,
} from "../background-bridge.js";
export { MAX_SUBAGENT_ACTIVE_TOOLS } from "../protocol.js";
export {
    isTerminalSubagentStatus,
    type NormalizeSubagentOptions,
    normalizeSubagentDetails,
    type SubagentStatus,
    type SubagentUsage,
    type SubagentViewModel,
    subagentPresentationKey,
} from "../view-model.js";
