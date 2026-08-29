import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { composeBoundedOutput, RetainedOutputStore, truncateUtf8 } from "#shared/lib/retained-output.js";
import { errorMessage } from "#shared/lib/validate.js";
import type { BackgroundSubagentJobV1 } from "./background-protocol.js";
import { getPiInvocation } from "./child-agent.js";
import { childArgs, resolveProfileModel, type SubagentProfile } from "./profiles/index.js";
import {
    appendSubagentActivity,
    createInitialSubagentRun,
    createTerminalSubagentRun,
    isTerminalSubagentStatus,
    type SubagentRunV1,
    type SubagentStatus,
    updateSubagentRun,
} from "./run-state.js";
import { type RunSubagentOptions, runSubagent, type SubagentRunResult } from "./runner.js";
import type { AbortableSemaphore, SemaphoreRelease } from "./semaphore.js";
import { resolveWorkingDirectory } from "./working-directory.js";

const MAX_JOBS = 64;
const TITLE_BYTES = 160;
const PROMPT_BYTES = 2 * 1024;
const AUTO_RESULT_BYTES = 12 * 1024;
const WAIT_JOB_BYTES = 24 * 1024;
const WAIT_TOTAL_BYTES = 48 * 1024;
const DELIVERY_MAX_LINES = DEFAULT_MAX_LINES - 8;
const ERROR_PREVIEW_BYTES = 8 * 1024;
const FAILURE_ACTIVITY_TITLE_BYTES = 512;

/** The complete-output store the manager needs; RetainedOutputStore is the production implementation. */
export interface SubagentOutputStore {
    /** Retain one complete output; undefined when it was not retained (quota, shutdown, or storage). */
    savePath(output: string): Promise<string | undefined>;
    cleanup(): Promise<unknown>;
}

export interface SpawnInput {
    profile: SubagentProfile;
    prompt: string;
    cwd: string;
    model?: string;
    name?: string;
}
interface BackgroundManagerOptions {
    semaphore: AbortableSemaphore;
    run?: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
    invocation?: typeof getPiInvocation;
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    emit: (job: BackgroundSubagentJobV1, type?: "upsert" | "remove") => void;
    deliver: (result: BackgroundTerminalResult) => void;
    isIdle?: () => boolean;
    outputStore?: SubagentOutputStore;
}
export interface BackgroundTerminalResult {
    id: string;
    title: string;
    status: string;
    text: string;
    fullOutputPath?: string;
}
interface Job {
    snapshot: BackgroundSubagentJobV1;
    controller: AbortController;
    settlement: Promise<void>;
    output: string;
    terminal?: BackgroundTerminalResult;
    terminalConsumed: boolean;
}

function titleFor(input: SpawnInput): string {
    const candidate =
        input.name?.trim() ||
        input.prompt
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim() ||
        "Background subagent";
    return truncateUtf8(candidate.replace(/\s+/g, " "), TITLE_BYTES).content;
}
function copyJob(job: Job): BackgroundSubagentJobV1 {
    return structuredClone(job.snapshot);
}
/** Append a bounded diagnostic activity and settle the run into a terminal failure. */
function synthesizeFailure(
    run: SubagentRunV1,
    status: Extract<SubagentStatus, "failed" | "cancelled">,
    message: string,
    now: number,
): SubagentRunV1 {
    const annotated = appendSubagentActivity(
        run,
        {
            timestamp: now,
            kind: "diagnostic",
            title: truncateUtf8(message, FAILURE_ACTIVITY_TITLE_BYTES).content,
            isError: true,
        },
        now,
    );
    return createTerminalSubagentRun(
        annotated,
        { status, error: truncateUtf8(message, ERROR_PREVIEW_BYTES).content },
        now,
    );
}
function boundedResult(result: BackgroundTerminalResult, bytes: number): BackgroundTerminalResult {
    const cap = Math.max(0, bytes);
    if (!truncateUtf8(result.text, cap).truncated) return result;
    const text = composeBoundedOutput(
        result.text,
        { maxBytes: cap },
        result.fullOutputPath
            ? { retainedPath: result.fullOutputPath }
            : { nonRetentionReason: "complete output was not retained by the subagent" },
    );
    return { ...result, text };
}

export class BackgroundSubagentManager {
    private readonly jobs = new Map<string, Job>();
    private readonly waitInterest = new Map<string, number>();
    private readonly deferred = new Map<string, BackgroundTerminalResult>();
    private readonly options: Required<Omit<BackgroundManagerOptions, "outputStore">>;
    private readonly outputStore: SubagentOutputStore;
    private shuttingDown = false;
    constructor(options: BackgroundManagerOptions) {
        this.options = {
            ...options,
            run: options.run ?? runSubagent,
            invocation: options.invocation ?? getPiInvocation,
            environment: options.environment ?? process.env,
            now: options.now ?? Date.now,
            isIdle: options.isIdle ?? (() => false),
        };
        this.outputStore =
            options.outputStore ?? new RetainedOutputStore({ prefix: "pi-subagent-", fileName: "output.md" });
    }

    async spawn(input: SpawnInput, parentCwd: string, creationSignal?: AbortSignal): Promise<BackgroundSubagentJobV1> {
        if (this.shuttingDown) throw new Error("Background subagent manager is shutting down.");
        if (creationSignal?.aborted) throw new Error("Background subagent spawn was cancelled.");
        if (!input.prompt.trim()) throw new Error("Subagent prompt must not be empty.");
        const cwd = await resolveWorkingDirectory(input.cwd, parentCwd);
        if (creationSignal?.aborted) throw new Error("Background subagent spawn was cancelled.");
        this.prune(MAX_JOBS - 1);
        if (this.jobs.size >= MAX_JOBS) {
            throw new Error(`Cannot track more than ${MAX_JOBS} active background subagents.`);
        }
        const model = resolveProfileModel(input.profile, input.model, this.options.environment);
        const id = randomUUID();
        const now = this.options.now();
        const run = createInitialSubagentRun({ id, agent: input.profile.name, model, cwd, now });
        const controller = new AbortController();
        const job: Job = {
            snapshot: {
                id,
                title: titleFor(input),
                prompt: truncateUtf8(input.prompt, PROMPT_BYTES).content,
                run,
            },
            controller,
            settlement: Promise.resolve(),
            output: "",
            terminalConsumed: false,
        };
        this.jobs.set(id, job);
        this.emit(job);
        this.prune();
        // Deliberately detach only after all synchronous/async validation succeeds.
        job.settlement = this.execute(job, input.prompt, input.profile, model, cwd);
        return copyJob(job);
    }

    list(): BackgroundSubagentJobV1[] {
        return [...this.jobs.values()].map(copyJob);
    }
    check(id: string): BackgroundSubagentJobV1 {
        const job = this.require(id);
        return copyJob(job);
    }

    async wait(ids: string[], signal?: AbortSignal): Promise<BackgroundTerminalResult[]> {
        const requested = [...new Set(ids)].map((id) => this.require(id));
        // Waiters already present when a result settles share ownership. A wait begun
        // after automatic or explicit delivery must not replay that result.
        const jobs = requested.filter((job) => !job.terminalConsumed);
        for (const job of jobs)
            this.waitInterest.set(job.snapshot.id, (this.waitInterest.get(job.snapshot.id) ?? 0) + 1);
        let abortListener: (() => void) | undefined;
        let consumed = false;
        try {
            const settlement = Promise.all(jobs.map((job) => job.settlement));
            if (signal) {
                await Promise.race([
                    settlement,
                    new Promise<never>((_, reject) => {
                        abortListener = () =>
                            reject(Object.assign(new Error("Subagent wait was cancelled."), { name: "AbortError" }));
                        signal.addEventListener("abort", abortListener, { once: true });
                        if (signal.aborted) abortListener();
                    }),
                ]);
            } else {
                await settlement;
            }
            let remaining = WAIT_TOTAL_BYTES;
            consumed = true;
            return jobs.map((job) => {
                this.deferred.delete(job.snapshot.id);
                if (!job.terminal) throw new Error(`Background subagent ${job.snapshot.id} did not settle correctly.`);
                job.terminalConsumed = true;
                const result = boundedResult(job.terminal, Math.min(WAIT_JOB_BYTES, remaining));
                remaining -= Buffer.byteLength(result.text);
                return result;
            });
        } finally {
            if (signal && abortListener) signal.removeEventListener("abort", abortListener);
            for (const job of jobs) {
                const count = (this.waitInterest.get(job.snapshot.id) ?? 1) - 1;
                if (count > 0) this.waitInterest.set(job.snapshot.id, count);
                else {
                    this.waitInterest.delete(job.snapshot.id);
                    if (!consumed && job.terminal && this.deferred.has(job.snapshot.id) && this.options.isIdle()) {
                        this.deferred.delete(job.snapshot.id);
                        this.consumeAndDeliver(job);
                    }
                }
            }
        }
    }

    async cancel(ids: string[]): Promise<BackgroundSubagentJobV1[]> {
        const jobs = [...new Set(ids)].map((id) => this.require(id));
        for (const job of jobs) job.controller.abort();
        await Promise.all(jobs.map((job) => job.settlement));
        return jobs.map(copyJob);
    }

    flushDeferred(): void {
        if (this.shuttingDown) return;
        for (const [id] of this.deferred) {
            if ((this.waitInterest.get(id) ?? 0) > 0) continue;
            this.deferred.delete(id);
            this.consumeAndDeliver(this.require(id));
        }
    }

    /** Reopens the manager so a later session can spawn jobs after an earlier shutdown. */
    startSession(): void {
        this.shuttingDown = false;
        if (this.outputStore instanceof RetainedOutputStore) this.outputStore.startSession();
    }

    async shutdown(timeoutMs = 3_000): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.deferred.clear();
        const settlements = [...this.jobs.values()].map((job) => {
            job.controller.abort();
            return job.settlement;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.allSettled(settlements),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timer) clearTimeout(timer);
        this.deferred.clear();
        await this.outputStore.cleanup();
    }

    private require(id: string): Job {
        const job = this.jobs.get(id);
        if (!job) throw new Error(`Unknown background subagent job: ${id}`);
        return job;
    }
    private emit(job: Job, type?: "upsert" | "remove"): void {
        if (this.shuttingDown) return;
        try {
            this.options.emit(copyJob(job), type);
        } catch {
            // Host UI failures must not affect job lifecycle promises.
        }
    }
    private consumeAndDeliver(job: Job): void {
        if (!job.terminal || job.terminalConsumed) return;
        job.terminalConsumed = true;
        try {
            this.options.deliver(boundedResult(job.terminal, AUTO_RESULT_BYTES));
        } catch {
            // Host delivery failures must not reject or duplicate settled jobs.
        }
    }
    private publish(job: Job, run: SubagentRunV1): void {
        job.snapshot = { ...job.snapshot, run };
        this.emit(job);
    }
    /**
     * Run one Job from queued to terminal: queue activity, semaphore acquisition, child
     * invocation, runner execution, terminal synthesis for any failure, output spill, and
     * result delivery. Never rejects; failures settle into the run state.
     */
    private async execute(
        job: Job,
        prompt: string,
        profile: SubagentProfile,
        model: string,
        cwd: string,
    ): Promise<void> {
        const { semaphore, run: runChild, invocation, now } = this.options;
        const signal = job.controller.signal;
        let run = job.snapshot.run;
        let output = "";
        let release: SemaphoreRelease | undefined;

        run = appendSubagentActivity(
            run,
            { timestamp: now(), kind: "diagnostic", title: "Queued for a child Pi process" },
            now(),
        );
        this.publish(job, run);
        try {
            try {
                release = await semaphore.acquire(signal);
            } catch (error) {
                throw new Error("Subagent was cancelled while queued.", { cause: error });
            }
            if (signal.aborted) throw new Error("Subagent was cancelled before it started.");

            const startedAt = now();
            run = updateSubagentRun(run, { status: "starting", phase: "spawning", startedAt }, startedAt);
            run = appendSubagentActivity(
                run,
                { timestamp: startedAt, kind: "diagnostic", title: "Starting child Pi" },
                startedAt,
            );
            this.publish(job, run);

            const child = invocation(childArgs(profile, model, prompt));
            const execution = await runChild({
                run,
                command: child.command,
                args: child.args,
                cwd,
                timeoutMs: profile.timeoutMs,
                signal,
                onSnapshot: (next) => {
                    run = next;
                    this.publish(job, next);
                },
            });
            run = execution.run;
            output = execution.output;
            if (!isTerminalSubagentStatus(run.status)) throw new Error(`Subagent ${run.status}.`);
        } catch (error) {
            if (!isTerminalSubagentStatus(run.status)) {
                run = synthesizeFailure(run, signal.aborted ? "cancelled" : "failed", errorMessage(error), now());
                this.publish(job, run);
            }
        } finally {
            release?.();
        }
        this.publish(job, run);

        const delivered = output || run.error || "(no output)";
        const truncation = truncateHead(delivered, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DELIVERY_MAX_LINES });
        const needsSpill = truncation.truncated || truncateUtf8(delivered, AUTO_RESULT_BYTES).truncated;
        let savedPath: string | undefined;
        if (needsSpill) {
            try {
                savedPath = await this.outputStore.savePath(delivered);
            } catch {
                // Retention is best effort; the terminal snapshot must still settle.
            }
        }
        const fullOutputPath = savedPath ?? run.fullOutputPath;
        if (fullOutputPath && fullOutputPath !== run.fullOutputPath) {
            run = updateSubagentRun(run, { fullOutputPath }, now());
            this.publish(job, run);
        }
        job.output = output;
        job.terminal = Object.freeze({
            id: job.snapshot.id,
            title: job.snapshot.title,
            status: run.status,
            text: truncation.content,
            ...(fullOutputPath ? { fullOutputPath } : {}),
        });
        if (!this.shuttingDown) {
            if ((this.waitInterest.get(job.snapshot.id) ?? 0) > 0) this.deferred.set(job.snapshot.id, job.terminal);
            else if (this.options.isIdle()) this.consumeAndDeliver(job);
            else this.deferred.set(job.snapshot.id, job.terminal);
        }
        this.prune();
    }
    private prune(limit = MAX_JOBS): void {
        while (this.jobs.size > limit) {
            const oldest = [...this.jobs.values()].find(
                (job) =>
                    job.terminal !== undefined &&
                    !this.deferred.has(job.snapshot.id) &&
                    (this.waitInterest.get(job.snapshot.id) ?? 0) === 0,
            );
            if (!oldest) break;
            this.jobs.delete(oldest.snapshot.id);
            this.emit(oldest, "remove");
        }
    }
}
