import {
    type ChildAgentEvent,
    type ChildAgentState,
    runChildAgent,
    type SpawnChildAgent,
} from "../shared/child-agent.js";
import { truncateUtf8 } from "../shared/retained-output.js";
import {
    appendSubagentActivity,
    createTerminalSubagentDetails,
    isSubagentDetailsV1,
    type SubagentDetailsV1,
    updateSubagentDetails,
} from "./protocol.js";

const ACTIVITY_TITLE_BYTES = 512;

export interface RunSubagentOptions {
    details: SubagentDetailsV1;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onSnapshot?: (details: SubagentDetailsV1) => void;
    throttleMs?: number;
    killGraceMs?: number;
    now?: () => number;
    spawn?: SpawnChildAgent;
}

export interface SubagentRunResult {
    details: SubagentDetailsV1;
    output: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * Run one child Pi process and always return a structured terminal snapshot: the protocol adapter
 * folding the shared child-agent runtime's event stream into `SubagentDetailsV1`. The caller
 * decides whether a failed terminal result should be thrown as a tool error.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
    if (!isSubagentDetailsV1(options.details)) throw new Error("runSubagent requires valid protocol v1 details");

    const now = options.now ?? Date.now;
    let details = structuredClone(options.details);
    const publish = () => {
        if (!options.onSnapshot) return;
        try {
            options.onSnapshot(structuredClone(details));
        } catch {
            // Renderer progress must never be able to strand the child process.
        }
    };
    const fold = (events: ChildAgentEvent[], state: ChildAgentState) => {
        for (const event of events) {
            if (event.kind === "spawned") {
                details = updateSubagentDetails(
                    details,
                    {
                        status: "running",
                        phase: "thinking",
                        startedAt: details.run.startedAt ?? event.timestamp,
                        activeTools: [],
                    },
                    event.timestamp,
                );
            } else {
                details = appendSubagentActivity(
                    details,
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
        details = updateSubagentDetails(
            details,
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
        model: details.run.model,
        usage: details.run.usage,
        signal: options.signal,
        onFlush: fold,
        throttleMs: options.throttleMs,
        killGraceMs: options.killGraceMs,
        now: options.now,
        spawn: options.spawn,
    });

    const succeeded = result.status === "succeeded";
    const endedAt = now();
    details = appendSubagentActivity(
        details,
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
    details = createTerminalSubagentDetails(
        details,
        {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            ...(result.outputPreview ? { outputPreview: result.outputPreview } : {}),
            model: result.model,
        },
        now(),
    );
    publish();

    return { details, output: result.output, stderr: result.stderr, exitCode: result.exitCode, signal: result.signal };
}
