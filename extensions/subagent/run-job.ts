import { DEFAULT_MAX_BYTES, truncateHead } from "@earendil-works/pi-coding-agent";
import { type AgentPreset, childArgs } from "../shared/presets.js";
import type { AbortableSemaphore, SemaphoreRelease } from "../shared/semaphore.js";
import { errorMessage } from "../shared/validate.js";
import {
    appendSubagentActivity,
    createTerminalSubagentDetails,
    isTerminalSubagentStatus,
    type SubagentDetailsV1,
    type SubagentStatus,
    truncateUtf8,
    updateSubagentDetails,
} from "./protocol.js";
import type { getPiInvocation, RunSubagentOptions, SubagentRunResult } from "./runner.js";

const ERROR_PREVIEW_BYTES = 8 * 1024;
const FAILURE_ACTIVITY_TITLE_BYTES = 512;

export interface SubagentJobDependencies {
    semaphore: AbortableSemaphore;
    run: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
    invocation: typeof getPiInvocation;
    now: () => number;
}

/** The complete-output store the subagent extension needs; RetainedOutputStore is the production implementation. */
export interface SubagentOutputStore {
    /** Retain one complete output; undefined when it was not retained (quota, shutdown, or storage). */
    savePath(output: string): Promise<string | undefined>;
    cleanup(): Promise<unknown>;
}

export interface SubagentJobSpillPolicy {
    store: Pick<SubagentOutputStore, "savePath">;
    /** Line cap applied to the model-deliverable text. */
    maxLines: number;
    /** Also spill the full output when the delivered text exceeds this byte budget without hard truncation. */
    spillOverBytes?: number;
}

export interface SubagentJobRequest {
    /** Queued protocol snapshot whose cwd has already been resolved. */
    details: SubagentDetailsV1;
    agent: AgentPreset;
    model: string | undefined;
    prompt: string;
    cwd: string;
    signal: AbortSignal;
    /** Receives every details mutation, including runner snapshots and terminal synthesis. */
    publish: (details: SubagentDetailsV1) => void;
    /** Receives the terminal snapshot as soon as the run settles, before the output spill. */
    onSettled?: (details: SubagentDetailsV1) => void;
    spill: SubagentJobSpillPolicy;
}

export interface SubagentJobResult {
    /** Terminal protocol snapshot; includes fullOutputPath when the output spilled. */
    details: SubagentDetailsV1;
    /** Raw child output; empty when the pipeline failed before producing output. */
    output: string;
    /** Model-deliverable text: the output, else the terminal error, else a placeholder. */
    delivered: string;
    truncation: ReturnType<typeof truncateHead>;
    fullOutputPath?: string;
    /** The underlying error when the job settled through failure synthesis. */
    failure?: unknown;
}

/** Append a bounded diagnostic activity and settle the details into a terminal failure snapshot. */
export function synthesizeSubagentFailure(
    details: SubagentDetailsV1,
    status: Extract<SubagentStatus, "failed" | "cancelled">,
    message: string,
    now: number,
): SubagentDetailsV1 {
    const annotated = appendSubagentActivity(
        details,
        {
            timestamp: now,
            kind: "diagnostic",
            title: truncateUtf8(message, FAILURE_ACTIVITY_TITLE_BYTES).content,
            isError: true,
        },
        now,
    );
    return createTerminalSubagentDetails(
        annotated,
        { status, error: truncateUtf8(message, ERROR_PREVIEW_BYTES).content },
        now,
    );
}

/**
 * Run one subagent job from queued details to a terminal snapshot: queue activity,
 * semaphore acquisition, child invocation, runner execution, terminal synthesis for
 * any failure, and full-output spill. Never rejects; failures settle into details.
 */
export async function runSubagentJob(
    deps: SubagentJobDependencies,
    request: SubagentJobRequest,
): Promise<SubagentJobResult> {
    const { semaphore, run, invocation, now } = deps;
    let details = request.details;
    let output = "";
    let failure: unknown;
    let release: SemaphoreRelease | undefined;
    const publish = (next: SubagentDetailsV1) => {
        try {
            request.publish(next);
        } catch {
            // Presentation failures must not affect job settlement.
        }
    };

    details = appendSubagentActivity(
        details,
        { timestamp: now(), kind: "diagnostic", title: "Queued for a child Pi process" },
        now(),
    );
    publish(details);

    try {
        try {
            release = await semaphore.acquire(request.signal);
        } catch (error) {
            throw new Error("Subagent was cancelled while queued.", { cause: error });
        }
        if (request.signal.aborted) throw new Error("Subagent was cancelled before it started.");

        const startedAt = now();
        details = updateSubagentDetails(details, { status: "starting", phase: "spawning", startedAt }, startedAt);
        details = appendSubagentActivity(
            details,
            { timestamp: startedAt, kind: "diagnostic", title: "Starting child Pi" },
            startedAt,
        );
        publish(details);

        const child = invocation(childArgs(request.agent, request.model, request.prompt));
        const execution = await run({
            details,
            command: child.command,
            args: child.args,
            cwd: request.cwd,
            timeoutMs: request.agent.timeoutMs,
            signal: request.signal,
            onSnapshot: (next) => {
                details = next;
                publish(next);
            },
        });
        details = execution.details;
        output = execution.output;
        if (!isTerminalSubagentStatus(details.run.status)) throw new Error(`Subagent ${details.run.status}.`);
    } catch (error) {
        failure = error;
        if (!isTerminalSubagentStatus(details.run.status)) {
            details = synthesizeSubagentFailure(
                details,
                request.signal.aborted ? "cancelled" : "failed",
                errorMessage(error),
                now(),
            );
            publish(details);
        }
    } finally {
        release?.();
    }
    request.onSettled?.(details);

    const delivered = output || details.run.error || "(no output)";
    const truncation = truncateHead(delivered, { maxBytes: DEFAULT_MAX_BYTES, maxLines: request.spill.maxLines });
    const needsSpill =
        truncation.truncated ||
        (request.spill.spillOverBytes !== undefined && truncateUtf8(delivered, request.spill.spillOverBytes).truncated);
    let savedPath: string | undefined;
    if (needsSpill) {
        try {
            savedPath = await request.spill.store.savePath(delivered);
        } catch {
            // Retention is best effort; the terminal snapshot must still settle.
        }
    }
    const fullOutputPath = savedPath ?? details.run.fullOutputPath;
    if (fullOutputPath && fullOutputPath !== details.run.fullOutputPath) {
        details = updateSubagentDetails(details, { fullOutputPath }, now());
    }
    return {
        details,
        output,
        delivered,
        truncation,
        ...(fullOutputPath ? { fullOutputPath } : {}),
        ...(failure !== undefined ? { failure } : {}),
    };
}
