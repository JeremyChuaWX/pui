import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { BackgroundSubagentJobV1 } from "./background-protocol.js";
import {
    AGENTS,
    type AgentName,
    childArgs,
    type ResolvedAgentName,
    resolveModel,
    resolveWorkingDirectory,
} from "./presets.js";
import {
    appendSubagentActivity,
    createInitialSubagentDetails,
    createTerminalSubagentDetails,
    isTerminalSubagentStatus,
    type SubagentDetailsV1,
    truncateUtf8,
    updateSubagentDetails,
} from "./protocol.js";
import { getPiInvocation, type RunSubagentOptions, runSubagent, type SubagentRunResult } from "./runner.js";
import type { AbortableSemaphore, SemaphoreRelease } from "./semaphore.js";

const MAX_JOBS = 64;
const TITLE_BYTES = 160;
const PROMPT_BYTES = 2 * 1024;
const AUTO_RESULT_BYTES = 12 * 1024;
const WAIT_JOB_BYTES = 24 * 1024;
const WAIT_TOTAL_BYTES = 48 * 1024;
const DELIVERY_MAX_LINES = DEFAULT_MAX_LINES - 8;

export interface SpawnInput {
    prompt: string;
    cwd: string;
    agent?: AgentName;
    model?: string;
    name?: string;
}
export interface BackgroundManagerOptions {
    semaphore: AbortableSemaphore;
    run?: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
    invocation?: typeof getPiInvocation;
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    emit: (job: BackgroundSubagentJobV1, type?: "upsert" | "remove") => void;
    deliver: (result: BackgroundTerminalResult) => void;
    isIdle?: () => boolean;
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
    const snapshot = structuredClone(job.snapshot);
    snapshot.title = truncateUtf8(snapshot.title, TITLE_BYTES).content;
    if (snapshot.prompt) snapshot.prompt = truncateUtf8(snapshot.prompt, PROMPT_BYTES).content;
    snapshot.run.agent = truncateUtf8(snapshot.run.agent, 128).content;
    snapshot.run.model = truncateUtf8(snapshot.run.model, 256).content;
    snapshot.run.cwd = truncateUtf8(snapshot.run.cwd, 2 * 1024).content;
    if (snapshot.run.outputPreview)
        snapshot.run.outputPreview = truncateUtf8(snapshot.run.outputPreview, 4 * 1024).content;
    if (snapshot.run.error) snapshot.run.error = truncateUtf8(snapshot.run.error, 8 * 1024).content;
    if (snapshot.run.fullOutputPath)
        snapshot.run.fullOutputPath = truncateUtf8(snapshot.run.fullOutputPath, 2 * 1024).content;
    snapshot.run.activeTools = snapshot.run.activeTools.map((tool) => ({
        ...tool,
        id: truncateUtf8(tool.id, 256).content,
        name: truncateUtf8(tool.name, 128).content,
        title: truncateUtf8(tool.title, 512).content,
    }));
    snapshot.run.recentActivity = snapshot.run.recentActivity.map((activity) => ({
        ...activity,
        title: truncateUtf8(activity.title, 512).content,
    }));
    return snapshot;
}
async function saveOutput(output: string): Promise<string | undefined> {
    try {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
        await fs.promises.chmod(directory, 0o700);
        const file = path.join(directory, "output.md");
        await fs.promises.writeFile(file, output, { encoding: "utf8", mode: 0o600 });
        return file;
    } catch {
        return undefined;
    }
}
function boundedResult(result: BackgroundTerminalResult, bytes: number): BackgroundTerminalResult {
    const cap = Math.max(0, bytes);
    const truncation = truncateUtf8(result.text, cap);
    if (!truncation.truncated) return result;
    const notice = result.fullOutputPath
        ? `\n\n[Output truncated for delivery. Full output: ${result.fullOutputPath}]`
        : "\n\n[Output truncated for delivery.]";
    const boundedNotice = truncateUtf8(notice, cap).content;
    const bodyBudget = Math.max(0, cap - Buffer.byteLength(boundedNotice, "utf8"));
    return { ...result, text: `${truncateUtf8(result.text, bodyBudget).content}${boundedNotice}` };
}

export class BackgroundSubagentManager {
    private readonly jobs = new Map<string, Job>();
    private readonly waitInterest = new Map<string, number>();
    private readonly deferred = new Map<string, BackgroundTerminalResult>();
    private shuttingDown = false;
    constructor(private readonly options: BackgroundManagerOptions) {}

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
        const model = resolveModel(agent, input.model, this.options.environment ?? process.env);
        const id = randomUUID();
        const now = (this.options.now ?? Date.now)();
        const details = appendSubagentActivity(
            createInitialSubagentDetails({ id, agent: agentName, model: model ?? "default", cwd, now }),
            { timestamp: now, kind: "diagnostic", title: "Queued for a child Pi process" },
            now,
        );
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
        };
        this.jobs.set(id, job);
        this.options.emit(copyJob(job));
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
        const jobs = [...new Set(ids)].map((id) => this.require(id));
        for (const job of jobs)
            this.waitInterest.set(job.snapshot.id, (this.waitInterest.get(job.snapshot.id) ?? 0) + 1);
        let abortListener: (() => void) | undefined;
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
            return jobs.map((job) => {
                this.deferred.delete(job.snapshot.id);
                if (!job.terminal) throw new Error(`Background subagent ${job.snapshot.id} did not settle correctly.`);
                const result = boundedResult(job.terminal, Math.min(WAIT_JOB_BYTES, remaining));
                remaining -= Buffer.byteLength(result.text);
                return result;
            });
        } finally {
            if (signal && abortListener) signal.removeEventListener("abort", abortListener);
            for (const job of jobs) {
                const count = (this.waitInterest.get(job.snapshot.id) ?? 1) - 1;
                if (count > 0) this.waitInterest.set(job.snapshot.id, count);
                else this.waitInterest.delete(job.snapshot.id);
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
        for (const [id, result] of this.deferred) {
            this.deferred.delete(id);
            try {
                this.options.deliver(boundedResult(result, AUTO_RESULT_BYTES));
            } catch {
                // Host delivery failures must not reject or duplicate settled jobs.
            }
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
    }

    private require(id: string): Job {
        const job = this.jobs.get(id);
        if (!job) throw new Error(`Unknown background subagent job: ${id}`);
        return job;
    }
    private publish(job: Job, details: SubagentDetailsV1): void {
        job.snapshot = { ...job.snapshot, run: details.run };
        if (!this.shuttingDown) this.options.emit(copyJob(job));
    }
    private async execute(
        job: Job,
        prompt: string,
        agentName: ResolvedAgentName,
        model: string | undefined,
        cwd: string,
    ): Promise<void> {
        let release: SemaphoreRelease | undefined;
        let details: SubagentDetailsV1 = { schema: "pi.subagent", version: 1, run: job.snapshot.run };
        try {
            release = await this.options.semaphore.acquire(job.controller.signal);
            if (job.controller.signal.aborted) throw new Error("Subagent was cancelled before it started.");
            const startedAt = (this.options.now ?? Date.now)();
            details = appendSubagentActivity(
                updateSubagentDetails(details, { status: "starting", phase: "spawning", startedAt }, startedAt),
                { timestamp: startedAt, kind: "diagnostic", title: "Starting child Pi" },
                startedAt,
            );
            this.publish(job, details);
            const invocation = (this.options.invocation ?? getPiInvocation)(
                childArgs(AGENTS[agentName], model, prompt),
            );
            const execution = await (this.options.run ?? runSubagent)({
                details,
                command: invocation.command,
                args: invocation.args,
                cwd,
                timeoutMs: AGENTS[agentName].timeoutMs,
                signal: job.controller.signal,
                onSnapshot: (next) => {
                    details = next;
                    this.publish(job, next);
                },
            });
            details = execution.details;
            job.output = execution.output;
            this.publish(job, details);
        } catch (error) {
            if (!isTerminalSubagentStatus(details.run.status))
                details = createTerminalSubagentDetails(
                    details,
                    {
                        status: job.controller.signal.aborted ? "cancelled" : "failed",
                        error: truncateUtf8(error instanceof Error ? error.message : String(error), 8 * 1024).content,
                    },
                    (this.options.now ?? Date.now)(),
                );
            this.publish(job, details);
        } finally {
            release?.();
        }
        const output = job.output || details.run.error || "(no output)";
        const hard = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DELIVERY_MAX_LINES });
        const needsDeliverySpill = hard.truncated || truncateUtf8(output, AUTO_RESULT_BYTES).truncated;
        const fullOutputPath =
            (needsDeliverySpill ? await saveOutput(output) : undefined) ?? details.run.fullOutputPath;
        if (fullOutputPath) {
            details = updateSubagentDetails(details, { fullOutputPath }, (this.options.now ?? Date.now)());
            this.publish(job, details);
        }
        job.terminal = Object.freeze({
            id: job.snapshot.id,
            title: job.snapshot.title,
            status: details.run.status,
            text: hard.content,
            ...(fullOutputPath ? { fullOutputPath } : {}),
        });
        if (!this.shuttingDown && (this.waitInterest.get(job.snapshot.id) ?? 0) === 0) {
            if (this.options.isIdle?.()) {
                try {
                    this.options.deliver(boundedResult(job.terminal, AUTO_RESULT_BYTES));
                } catch {
                    // Host delivery failures must not reject or duplicate settled jobs.
                }
            } else this.deferred.set(job.snapshot.id, job.terminal);
        }
        this.prune();
    }
    private prune(limit = MAX_JOBS): void {
        while (this.jobs.size > limit) {
            const oldest = [...this.jobs.values()].find(
                (job) => isTerminalSubagentStatus(job.snapshot.run.status) && !this.deferred.has(job.snapshot.id),
            );
            if (!oldest) break;
            this.jobs.delete(oldest.snapshot.id);
            if (!this.shuttingDown) this.options.emit(copyJob(oldest), "remove");
        }
    }
}
