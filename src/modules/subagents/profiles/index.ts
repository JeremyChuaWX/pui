import explorer from "./explorer/index.js";
import worker from "./worker/index.js";

export type { Profile } from "./profile.js";

/** Every Profile listed here is registered as a spawn tool. */
export const profiles = [explorer, worker];
