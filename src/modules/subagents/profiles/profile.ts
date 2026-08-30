import type { ProfileConfig } from "../protocol.js";

const MINUTE = 60_000;

export interface Profile {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    config: ProfileConfig;
}

/** The two liveness Limits shared by every Profile. */
export const DEFAULT_LIMITS = { inactivityMs: 10 * MINUTE, hardMs: 60 * MINUTE };

type ProfileInput = Omit<Profile, "config"> &
    Omit<ProfileConfig, keyof typeof DEFAULT_LIMITS> &
    Partial<typeof DEFAULT_LIMITS>;

export function defineProfile(input: ProfileInput): Profile {
    const { name, label, description, promptSnippet, promptGuidelines, ...config } = input;
    return {
        name,
        label,
        description,
        promptSnippet,
        promptGuidelines,
        config: { ...DEFAULT_LIMITS, ...config },
    };
}
