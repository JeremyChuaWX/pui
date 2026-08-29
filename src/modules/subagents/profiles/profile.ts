/** The three watchdogs every Job runs under. Each is in milliseconds; 0 disables that Limit. */
export interface JobLimits {
    /** Whole-Job wall clock, counted from spawn regardless of activity. */
    wallClockMs: number;
    /** Time without a child event while no tool is active. */
    stallTimeoutMs: number;
    /** Time without a child event while a tool is active; streaming tool output resets it. */
    toolStallTimeoutMs: number;
}

const MINUTE = 60_000;

/** Default Limits shared by every Profile. A Profile may override any one of them. */
export const DEFAULT_LIMITS: JobLimits = {
    wallClockMs: 60 * MINUTE,
    stallTimeoutMs: 10 * MINUTE,
    toolStallTimeoutMs: 15 * MINUTE,
};

const CHILD_ISOLATION_FLAGS = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
] as const;

/** One child-agent configuration: a spawn tool name, its child tool allowlist, model, prompt, and Limits. */
export interface SubagentProfile extends JobLimits {
    name: string;
    label: string;
    /** What the child is for and what it may touch; the registered tool description adds tools, model, and Limits. */
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    tools: readonly string[];
    defaultModel: string;
    /** Environment variable consulted before the default model. */
    modelEnv: string;
    prompt: string;
    /** Whether the prompt replaces Pi's coding prompt or is appended to it. */
    promptFlag: "--system-prompt" | "--append-system-prompt";
}

export type ProfileDeclaration = Omit<SubagentProfile, keyof JobLimits> & Partial<JobLimits>;

export function defineProfile(profile: ProfileDeclaration): SubagentProfile {
    return { ...DEFAULT_LIMITS, ...profile };
}

/** The effective Limits of a Profile, ready to hand to the child runner. */
export function profileLimits(profile: SubagentProfile): JobLimits {
    return {
        wallClockMs: profile.wallClockMs,
        stallTimeoutMs: profile.stallTimeoutMs,
        toolStallTimeoutMs: profile.toolStallTimeoutMs,
    };
}

/** Explicit argument first, then the Profile's environment variable, then its default. Blank values are ignored. */
export function resolveProfileModel(
    profile: SubagentProfile,
    override: string | undefined,
    environment: NodeJS.ProcessEnv,
): string {
    const explicit = override?.trim();
    if (explicit) return explicit;
    const configured = environment[profile.modelEnv]?.trim();
    return configured || profile.defaultModel;
}

/** The child Pi argument list: JSON event mode, isolation flags, the tool allowlist, model, prompt, and task. */
export function childArgs(profile: SubagentProfile, model: string, prompt: string): string[] {
    return [
        "--mode",
        "json",
        ...CHILD_ISOLATION_FLAGS,
        "--tools",
        profile.tools.join(","),
        "--model",
        model,
        profile.promptFlag,
        profile.prompt,
        prompt,
    ];
}

/** "60 minutes", "2.5 minutes", or "disabled" for a zero Limit. */
export function describeLimit(ms: number): string {
    if (ms <= 0) return "disabled";
    const value = ms / MINUTE;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} minute${value === 1 ? "" : "s"}`;
}

/** The sentence a spawn tool description ends with so the model can pick a Profile without reading docs. */
export function describeProfile(profile: SubagentProfile): string {
    return (
        `Tools: ${profile.tools.join(", ")}. ` +
        `Default model: ${profile.defaultModel} (override with the model argument or ${profile.modelEnv}). ` +
        `Limits: ${describeLimit(profile.wallClockMs)} wall clock, ${describeLimit(profile.stallTimeoutMs)} stall, ` +
        `${describeLimit(profile.toolStallTimeoutMs)} tool stall.`
    );
}
