import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
    AGENTS,
    type AgentName,
    type ResolvedAgentName,
    resolveModel,
    resolveWorkingDirectory,
} from "../shared/presets.js";
import { formatTruncationNotice, RetainedOutputStore } from "../shared/retained-output.js";
import type { AbortableSemaphore } from "../shared/semaphore.js";
import type { BackgroundSubagentJobV1 } from "./background-protocol.js";
import {
    createInitialSubagentDetails,
    SUBAGENT_PROTOCOL_VERSION,
    SUBAGENT_SCHEMA,
    type SubagentDetailsV1,
    truncateUtf8,
} from "./protocol.js";
import type { SubagentOutputStore } from "./run-job.js";
import { runSubagentJob } from "./run-job.js";
import { getPiInvocation, type RunSubagentOptions, runSubagent, type SubagentRunResult } from "./runner.js";

const MAX_JOBS = 64;
const TITLE_BYTES = 160;
const PROMPT_BYTES = 2 * 1024;
const AUTO_RESULT_BYTES = 12 * 1024;
const WAIT_JOB_BYTES = 24 * 1024;
const WAIT_TOTAL_BYTES = 48 * 1024;
const DELIVERY_MAX_LINES = DEFAULT_MAX_LINES - 8;

interface SpawnInput {
    prompt: string;
    cwd: string;
    agent?: AgentName;
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
function boundedResult(result: BackgroundTerminalResult, bytes: number): BackgroundTerminalResult {
    const cap = Math.max(0, bytes);
    const truncation = truncateUtf8(result.text, cap);
    if (!truncation.truncated) return result;
    const noticeFor = (outputBytes: number) =>
        formatTruncationNotice({
            outputBytes,
            totalBytes: truncation.totalBytes,
            ...(result.fullOutputPath
                ? { retainedPath: result.fullOutputPath }
                : { nonRetentionReason: "complete output was not retained by the subagent" }),
        });
    let notice = noticeFor(0);
    let body = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        const separator = cap >= Buffer.byteLength(notice, "utf8") + 2 ? "\n\n" : "";
        const bodyBudget = Math.max(0, cap - Buffer.byteLength(separator + notice, "utf8"));
        body = truncateUtf8(result.text, bodyBudget).content;
        const next = noticeFor(Buffer.byteLength(body, "utf8"));
        if (next === notice) return { ...result, text: `${body}${separator}${notice}` };
        notice = next;
    }
    const boundedNotice = truncateUtf8(notice, cap).content;
    const bodyBudget = Math.max(0, cap - Buffer.byteLength(boundedNotice, "utf8") - 2);
    body = truncateUtf8(result.text, bodyBudget).content;
    return { ...result, text: body ? `${body}\n\n${boundedNotice}` : boundedNotice };
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
        const agentName: ResolvedAgentName = input.agent ?? "generic";
        const agent = AGENTS[agentName];
        const model = resolveModel(agent, input.model, this.options.environment);
        const id = randomUUID();
        const now = this.options.now();
        const details = createInitialSubagentDetails({ id, agent: agentName, model: model ?? "default", cwd, now });
        const controller = new AbortController();
        const job: Job = {
            snapshot: {
                id,
                title: titleFor(input),
                prompt: truncateUtf8(input.prompt, PROMPT_BYTES).content,
                run: details.run,
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
        job.settlement = this.execute(job, input.prompt, agentName, model, cwd);
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
    private publish(job: Job, details: SubagentDetailsV1): void {
        job.snapshot = { ...job.snapshot, run: details.run };
        this.emit(job);
    }
    private async execute(
        job: Job,
        prompt: string,
        agentName: ResolvedAgentName,
        model: string | undefined,
        cwd: string,
    ): Promise<void> {
        const details: SubagentDetailsV1 = {
            schema: SUBAGENT_SCHEMA,
            version: SUBAGENT_PROTOCOL_VERSION,
            run: job.snapshot.run,
        };
        const outcome = await runSubagentJob(
            {
                semaphore: this.options.semaphore,
                run: this.options.run,
                invocation: this.options.invocation,
                now: this.options.now,
            },
            {
                details,
                agent: AGENTS[agentName],
                model,
                prompt,
                cwd,
                signal: job.controller.signal,
                publish: (next) => this.publish(job, next),
                onSettled: (settled) => this.publish(job, settled),
                spill: { store: this.outputStore, maxLines: DELIVERY_MAX_LINES, spillOverBytes: AUTO_RESULT_BYTES },
            },
        );
        job.output = outcome.output;
        if (outcome.fullOutputPath) this.publish(job, outcome.details);
        job.terminal = Object.freeze({
            id: job.snapshot.id,
            title: job.snapshot.title,
            status: outcome.details.run.status,
            text: outcome.truncation.content,
            ...(outcome.fullOutputPath ? { fullOutputPath: outcome.fullOutputPath } : {}),
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
