import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Event-bus channel used to publish active Jobs to the pui UI. */
export const SUBAGENT_JOBS_CHANNEL = "pi.subagents.jobs";

/** Complete active-Job snapshot for one parent session. */
export interface SubagentJobsEvent {
    sessionId: string;
    jobs: Job[];
}

/** The execution settings a Profile declares. */
export interface ProfileConfig {
    tools: readonly string[];
    model: string;
    thinkingLevel: ThinkingLevel;
    systemPrompt: string;
    promptMode: "replace" | "append";
    inactivityMs: number;
    hardMs: number;
}

/** Everything a runner needs to execute one Job: the Profile settings plus the spawn call. */
export interface JobConfig extends ProfileConfig {
    profile: string;
    task: string;
    cwd: string;
}

export interface JobUsage {
    input: number;
    output: number;
    totalTokens: number;
    cost: number;
}

/** What a runner hands back. `partial` means an earlier assistant response had to be used. */
export interface RunResult {
    text: string;
    partial: boolean;
    usage: JobUsage;
}

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** One spawned child AgentSession, from queueing through terminal state. */
export interface Job {
    id: string;
    profile: string;
    task: string;
    cwd: string;
    state: JobState;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    result?: RunResult;
    error?: string;
}

/** Terminal Job as handed to the delivery callback. */
export interface JobResult {
    job: Job;
    status: Exclude<JobState, "queued" | "running">;
    text: string;
    partial: boolean;
    runtimeMs: number;
    usage?: JobUsage;
    error?: string;
}

/** Executes one Job and reports activity while it is live. */
export type Runner = (config: JobConfig, signal: AbortSignal, onActivity: () => void) => Promise<RunResult>;

export type Deliver = (result: JobResult) => void;
