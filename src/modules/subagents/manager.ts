import { type Clock, SYSTEM_CLOCK, unrefTimer } from "#shared/lib/clock.js";
import type { Deliver, Job, JobConfig, JobResult, Runner } from "./protocol.js";

export interface ManagerOptions {
    run: Runner;
    deliver: Deliver;
    maxActive: number;
    maxQueued: number;
    /** Receives Job snapshots; observer failures never affect Job lifecycle. */
    onChange?: (jobs: Job[]) => void;
    clock?: Clock;
}

interface Entry {
    job: Job;
    config: JobConfig;
    controller: AbortController;
    /** Resolves once the Job reaches a terminal state. */
    settled: Promise<Job>;
    settle: (job: Job) => void;
    inactivityTimer?: unknown;
    hardTimer?: unknown;
}

/** How long shutdown waits for children to wind down before giving up on them. */
const SHUTDOWN_GRACE_MS = 5_000;

export function seconds(ms: number): string {
    return `${Math.round(ms / 1_000)}s`;
}

/** A cancel or Limit may already have set the terminal state while the runner winds down. */
function finalStatus(job: Job, ifStillRunning: JobResult["status"]): JobResult["status"] {
    return job.state === "running" ? ifStillRunning : (job.state as JobResult["status"]);
}

/** Owns every Job: ids, queue, Limits, cancellation, and the single delivery path. */
export class Manager {
    private readonly entries = new Map<string, Entry>();
    private readonly counters = new Map<string, number>();
    private readonly clock: Clock;
    private closed = false;

    constructor(private readonly options: ManagerOptions) {
        this.clock = options.clock ?? SYSTEM_CLOCK;
    }

    spawn(config: JobConfig): Job {
        if (this.closed) throw new Error("Subagents are shutting down.");
        if (this.queued().length >= this.options.maxQueued) {
            throw new Error(
                `Subagent queue is full (${this.options.maxQueued} queued, ${this.options.maxActive} running).`,
            );
        }
        const n = (this.counters.get(config.profile) ?? 0) + 1;
        this.counters.set(config.profile, n);
        const job: Job = {
            id: `${config.profile}_${n}`,
            profile: config.profile,
            task: config.task,
            cwd: config.cwd,
            state: "queued",
            createdAt: this.clock.now(),
        };
        let settle!: (job: Job) => void;
        const settled = new Promise<Job>((resolve) => {
            settle = resolve;
        });
        this.entries.set(job.id, {
            job,
            config,
            controller: new AbortController(),
            settled,
            settle,
        });
        this.pump();
        this.notify();
        return { ...job };
    }

    /** Abort running Jobs, drop queued ones, and resolve when each reaches a terminal state. */
    cancel(ids: string[]): Promise<Job[]> {
        const entries = ids.map((id) => {
            const entry = this.entries.get(id);
            if (!entry) throw new Error(`Unknown subagent Job: ${id}`);
            return entry;
        });
        for (const entry of entries) {
            if (entry.job.state === "queued") {
                this.finish(entry, "cancelled");
            } else if (entry.job.state === "running") {
                entry.job.state = "cancelled";
                entry.controller.abort();
                this.notify();
            }
        }
        return Promise.all(entries.map((entry) => entry.settled));
    }

    /** Cancel every Job during session shutdown or Extension reload. */
    async shutdown(): Promise<void> {
        this.closed = true;
        const done = this.cancel([...this.entries.keys()]);
        await Promise.race([
            done,
            new Promise<void>((resolve) => {
                this.after(SHUTDOWN_GRACE_MS, resolve);
            }),
        ]);
    }

    list(): Job[] {
        return [...this.entries.values()].map(({ job }) => ({ ...job }));
    }

    private after(ms: number, fn: () => void): unknown {
        const timer = this.clock.setTimeout(fn, ms);
        unrefTimer(timer);
        return timer;
    }

    private clear(timer: unknown): void {
        if (timer !== undefined) this.clock.clearTimeout(timer);
    }

    private notify(): void {
        try {
            this.options.onChange?.(this.list());
        } catch {
            // Presentation failures must not affect Job lifecycle.
        }
    }

    private queued(): Entry[] {
        return [...this.entries.values()].filter(({ job }) => job.state === "queued");
    }

    private active(): number {
        return [...this.entries.values()].filter(({ job }) => job.state === "running").length;
    }

    /** Start queued Jobs, oldest first, while slots are free. */
    private pump(): void {
        if (this.closed) return;
        for (const entry of this.queued()) {
            if (this.active() >= this.options.maxActive) return;
            this.launch(entry);
        }
    }

    private launch(entry: Entry): void {
        const { job, config, controller } = entry;
        job.state = "running";
        job.startedAt = this.clock.now();
        const timeOut = (reason: string) => {
            if (job.state !== "running") return;
            job.state = "timed_out";
            job.error = reason;
            controller.abort();
            this.notify();
        };
        const armInactivity = () => {
            this.clear(entry.inactivityTimer);
            entry.inactivityTimer = this.after(config.inactivityMs, () =>
                timeOut(`Timed out: no activity for ${seconds(config.inactivityMs)}.`),
            );
        };
        armInactivity();
        entry.hardTimer = this.after(config.hardMs, () =>
            timeOut(`Timed out: hard limit of ${seconds(config.hardMs)} reached.`),
        );
        this.options.run(config, controller.signal, armInactivity).then(
            (result) => {
                job.result = result;
                this.finish(entry, finalStatus(job, "completed"));
            },
            (error: unknown) => {
                if (job.state === "running") job.error = error instanceof Error ? error.message : String(error);
                this.finish(entry, finalStatus(job, "failed"));
            },
        );
    }

    /** The only place a Job becomes terminal and the only result-delivery path. */
    private finish(entry: Entry, status: JobResult["status"]): void {
        const { job } = entry;
        this.clear(entry.inactivityTimer);
        this.clear(entry.hardTimer);
        job.state = status;
        job.endedAt = this.clock.now();
        this.entries.delete(job.id);
        entry.settle({ ...job });
        this.pump();
        this.notify();
        if (status === "cancelled" || this.closed) return;
        this.options.deliver({
            job: { ...job },
            status,
            text: job.result?.text ?? "",
            partial: job.result?.partial ?? false,
            runtimeMs: job.endedAt - (job.startedAt ?? job.createdAt),
            usage: job.result?.usage,
            error: job.error,
        });
    }
}
