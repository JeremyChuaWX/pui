import explorer from "./explorer/index.js";
import worker from "./worker/index.js";

export {
    childArgs,
    DEFAULT_LIMITS,
    describeLimit,
    describeProfile,
    type JobLimits,
    profileLimits,
    resolveProfileModel,
    type SubagentProfile,
} from "./profile.js";

/** Every Profile listed here is registered as a spawn tool. Add a Profile by declaring its directory and appending it. */
export const PROFILES = [explorer, worker] as const;
