import explorer from "./explorer/index.js";
import type { SubagentProfile } from "./profile.js";
import worker from "./worker/index.js";

export {
    childArgs,
    DEFAULT_LIMITS,
    describeProfile,
    type JobLimits,
    resolveProfileModel,
    type SubagentProfile,
} from "./profile.js";

/** Every Profile listed here is registered as a spawn tool. Add a Profile by declaring its directory and appending it. */
export const PROFILES = [explorer, worker] as const;
export const PROFILE_NAMES = PROFILES.map((profile) => profile.name) as ["explorer", "worker"];
export type ProfileName = (typeof PROFILE_NAMES)[number];
export const PROFILES_BY_NAME: Record<ProfileName, SubagentProfile> = { explorer, worker };
