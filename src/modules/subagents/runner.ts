import { truncateUtf8 } from "#shared/lib/retained-output.js";
import { type ChildAgentEvent, type ChildAgentState, runChildAgent, type SpawnChildAgent } from "./child-agent.js";
import {
    appendSubagentActivity,
    createTerminalSubagentRun,
    isSubagentRunV1,
    type SubagentRunV1,
    updateSubagentRun,
} from "./run-state.js";

const ACTIVITY_TITLE_BYTES = 512;

export interface RunSubagentOptions {
    run: SubagentRunV1;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onSnapshot?: (run: SubagentRunV1) => void;
    throttleMs?: number;
    killGraceMs?: number;
    now?: () => number;
    spawn?: SpawnChildAgent;
}

export interface SubagentRunResult {
    run: SubagentRunV1;
    output: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * Run one child Pi process and always return a structured terminal run: the adapter folding the
 * child-agent runtime's event stream into `SubagentRunV1`. The caller decides what a failed
 * terminal status means for the Job.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
    if (!isSubagentRunV1(options.run)) throw new Error("runSubagent requires a valid run state");

    const now = options.now ?? Date.now;
    let run = structuredClone(options.run);
    const publish = () => {
        if (!options.onSnapshot) return;
        try {
            options.onSnapshot(structuredClone(run));
        } catch {
            // Renderer progress must never be able to strand the child process.
        }
    };
    const fold = (events: ChildAgentEvent[], state: ChildAgentState) => {
        for (const event of events) {
            if (event.kind === "spawned") {
                run = updateSubagentRun(
                    run,
                    {
                        status: "running",
                        phase: "thinking",
                        startedAt: run.startedAt ?? event.timestamp,
                        activeTools: [],
                    },
                    event.timestamp,
                );
            } else {
                run = appendSubagentActivity(
                    run,
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
        run = updateSubagentRun(
            run,
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
        timeoutMs: options.timeoutMs,
        model: run.model,
        usage: run.usage,
        signal: options.signal,
        onFlush: fold,
        throttleMs: options.throttleMs,
        killGraceMs: options.killGraceMs,
        now: options.now,
        spawn: options.spawn,
    });

    const succeeded = result.status === "succeeded";
    const endedAt = now();
    run = appendSubagentActivity(
        run,
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
    run = createTerminalSubagentRun(
        run,
        {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            ...(result.outputPreview ? { outputPreview: result.outputPreview } : {}),
            model: result.model,
        },
        now(),
    );
    publish();

    return { run, output: result.output, stderr: result.stderr, exitCode: result.exitCode, signal: result.signal };
}
