import { type Clock, SYSTEM_CLOCK } from "#shared/lib/clock.js";
import { truncateUtf8 } from "#shared/lib/retained-output.js";
import { type ChildAgentEvent, type ChildAgentState, runChildAgent, type SpawnChildAgent } from "./child-agent.js";
import {
    appendSubagentActivity,
    createTerminalSubagentJob,
    isSubagentJobV1,
    type SubagentJobV1,
    updateSubagentJob,
} from "./job-state.js";
import type { JobLimits } from "./profiles/profile.js";

const ACTIVITY_TITLE_BYTES = 512;

export interface RunSubagentOptions {
    job: SubagentJobV1;
    command: string;
    args: string[];
    cwd: string;
    limits: JobLimits;
    signal?: AbortSignal;
    onSnapshot?: (job: SubagentJobV1) => void;
    throttleMs?: number;
    killGraceMs?: number;
    clock?: Clock;
    spawn?: SpawnChildAgent;
}

export interface RunSubagentResult {
    job: SubagentJobV1;
    output: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * Run one child Pi process and always return a structured terminal Job state: the adapter folding the
 * child-agent runtime's event stream into `SubagentJobV1`. The caller decides what a failed
 * terminal status means for the Job.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<RunSubagentResult> {
    if (!isSubagentJobV1(options.job)) throw new Error("runSubagent requires a valid Job state");

    const now = () => (options.clock ?? SYSTEM_CLOCK).now();
    let job = structuredClone(options.job);
    const publish = () => {
        if (!options.onSnapshot) return;
        try {
            options.onSnapshot(structuredClone(job));
        } catch {
            // Renderer progress must never be able to strand the child process.
        }
    };
    const fold = (events: ChildAgentEvent[], state: ChildAgentState) => {
        for (const event of events) {
            if (event.kind === "spawned") {
                job = updateSubagentJob(
                    job,
                    {
                        status: "running",
                        phase: "thinking",
                        startedAt: job.startedAt ?? event.timestamp,
                        activeTools: [],
                    },
                    event.timestamp,
                );
            } else {
                job = appendSubagentActivity(
                    job,
                    {
                        timestamp: event.timestamp,
                        kind: event.kind,
                        title: event.title,
                        ...("isError" in event ? { isError: event.isError } : {}),
                    },
                    event.timestamp,
                );
            }
        }
        job = updateSubagentJob(
            job,
            {
                phase: state.phase,
                activeTools: state.activeTools,
                model: state.model,
                usage: state.usage,
                ...(state.outputPreview ? { outputPreview: state.outputPreview } : {}),
            },
            state.updatedAt,
        );
        publish();
    };

    const result = await runChildAgent({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        limits: options.limits,
        model: job.model,
        usage: job.usage,
        signal: options.signal,
        onFlush: fold,
        throttleMs: options.throttleMs,
        killGraceMs: options.killGraceMs,
        clock: options.clock,
        spawn: options.spawn,
    });

    const succeeded = result.status === "succeeded";
    const endedAt = now();
    job = appendSubagentActivity(
        job,
        {
            timestamp: endedAt,
            kind: succeeded ? "assistant" : "diagnostic",
            title: truncateUtf8(
                succeeded ? "Subagent completed" : result.error?.split("\n", 1)[0] || "Subagent failed",
                ACTIVITY_TITLE_BYTES,
            ).content,
            isError: !succeeded,
        },
        endedAt,
    );
    job = createTerminalSubagentJob(
        job,
        {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            ...(result.outputPreview ? { outputPreview: result.outputPreview } : {}),
            model: result.model,
        },
        now(),
    );
    publish();

    return { job, output: result.output, stderr: result.stderr, exitCode: result.exitCode, signal: result.signal };
}
