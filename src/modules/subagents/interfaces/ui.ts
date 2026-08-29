/**
 * UI Entry: the Background Protocol as the TUI consumes it. The parser validates
 * extension-owned wire payloads and bounds every string for rendering; the bridge
 * owns event subscription, instance authority, and cancellation routing.
 */
export {
    BackgroundSubagentBridge,
    type BackgroundSubagentState,
    type BackgroundSubagentViewModel,
    parseBackgroundSubagentEvent,
    reduceBackgroundSubagentEvent,
} from "../background-bridge.js";
export { isTerminalSubagentStatus, type SubagentStatus, type SubagentUsageV1 as SubagentUsage } from "../job-state.js";
