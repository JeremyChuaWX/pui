/**
 * UI Entry: validated active-Job snapshots and the Controller bridge. The pui-specific bridge is
 * the only machinery not shared with the local Pi subagent Extension design.
 */
export {
    BackgroundSubagentBridge,
    type BackgroundSubagentViewModel,
    isTerminalSubagentStatus,
    parseSubagentJobsEvent,
    parseSubagentResultDetails,
    type SubagentResultViewModel,
} from "../background-bridge.js";
export type { JobState as SubagentStatus } from "../protocol.js";
