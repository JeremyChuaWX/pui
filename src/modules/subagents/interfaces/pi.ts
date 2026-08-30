import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Clock, SYSTEM_CLOCK } from "#shared/lib/clock.js";
import { Manager, seconds } from "../manager.js";
import { profiles } from "../profiles/index.js";
import { type Job, SUBAGENT_JOBS_CHANNEL, type SubagentJobsEvent } from "../protocol.js";
import { prepareResultMessage, renderResultMessage } from "../result-message.js";
import { createRunner } from "../subagent.js";

const DEFAULT_MAX_ACTIVE = 4;
const DEFAULT_MAX_QUEUED = 16;

function clamp(value: number, lower: number, upper: number): number {
    return Math.min(upper, Math.max(lower, value));
}

function configuredMaxActive(environment: NodeJS.ProcessEnv): number {
    const configured = environment.PI_SUBAGENT_MAX_ACTIVE;
    if (!configured?.trim()) return DEFAULT_MAX_ACTIVE;
    const parsed = Number(configured);
    const value = Number.isNaN(parsed) ? DEFAULT_MAX_ACTIVE : Math.trunc(parsed);
    return clamp(value, 1, 64);
}

/** "provider/model-id" as written in a Profile. */
function splitModel(spec: string): [string, string] {
    const slash = spec.indexOf("/");
    return [spec.slice(0, slash), spec.slice(slash + 1)];
}

export interface SubagentExtensionDependencies {
    createRunner?: typeof createRunner;
    environment?: NodeJS.ProcessEnv;
    clock?: Clock;
    maxActive?: number;
    maxQueued?: number;
}

export interface ResolvedSubagentExtensionDependencies {
    createRunner: typeof createRunner;
    clock: Clock;
    maxActive: number;
    maxQueued: number;
}

export function createDefaultSubagentDependencies(
    overrides: SubagentExtensionDependencies = {},
): ResolvedSubagentExtensionDependencies {
    return {
        createRunner: overrides.createRunner ?? createRunner,
        clock: overrides.clock ?? SYSTEM_CLOCK,
        maxActive: overrides.maxActive ?? configuredMaxActive(overrides.environment ?? process.env),
        maxQueued: overrides.maxQueued ?? DEFAULT_MAX_QUEUED,
    };
}

export function registerSubagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}): void {
    const resolved = createDefaultSubagentDependencies(dependencies);
    let manager: Manager | undefined;

    pi.registerMessageRenderer("subagent-result", renderResultMessage);

    pi.on("session_start", async (_event, ctx) => {
        const previous = manager;
        manager = undefined;
        await previous?.shutdown();

        const sessionId = ctx.sessionManager.getSessionId();
        const dir = path.join(os.tmpdir(), "pi-subagents", sessionId);
        let current!: Manager;
        const publishJobs = (jobs: Job[]) => {
            if (manager !== current) return;
            const event: SubagentJobsEvent = {
                sessionId,
                jobs: jobs.filter((job) => job.state === "queued" || job.state === "running"),
            };
            pi.events.emit(SUBAGENT_JOBS_CHANNEL, event);
        };
        current = new Manager({
            maxActive: resolved.maxActive,
            maxQueued: resolved.maxQueued,
            clock: resolved.clock,
            run: resolved.createRunner({
                resolveModel: (spec) => ctx.modelRegistry.find(...splitModel(spec)),
            }),
            deliver: (result) => {
                if (manager !== current) return;
                const message = prepareResultMessage(result, dir);
                pi.sendMessage(
                    { customType: "subagent-result", ...message, display: true },
                    { deliverAs: "steer", triggerTurn: true },
                );
            },
            onChange: publishJobs,
        });
        manager = current;
        publishJobs([]);
    });

    pi.on("session_shutdown", async () => {
        const current = manager;
        manager = undefined;
        await current?.shutdown();
    });

    const getManager = (): Manager => {
        if (!manager) throw new Error("Subagents are not ready: no session has started.");
        return manager;
    };

    for (const profile of profiles) {
        pi.registerTool({
            name: profile.name,
            label: profile.label,
            description: profile.description,
            promptSnippet: profile.promptSnippet,
            promptGuidelines: profile.promptGuidelines,
            parameters: Type.Object({
                task: Type.String({ description: "Focused, self-contained task for the subagent." }),
                cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current one." })),
            }),
            async execute(_id, params, _signal, _update, ctx) {
                const job = getManager().spawn({
                    ...profile.config,
                    profile: profile.name,
                    task: params.task,
                    cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Started ${job.id} (${job.state}). Its result will be injected when ready; do not wait or poll.`,
                        },
                    ],
                    details: job,
                };
            },
        });
    }

    pi.registerTool({
        name: "subagent_cancel",
        label: "Cancel Subagents",
        description:
            "Cancel queued or running subagent Jobs and return their final state. Cancelled Jobs emit no result message.",
        promptSnippet: "Cancel background subagent Jobs",
        parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }) }),
        async execute(_id, params) {
            const jobs = await getManager().cancel(params.ids);
            return {
                content: [{ type: "text", text: jobs.map((job) => `[${job.id}] ${job.state}`).join("\n") }],
                details: { jobs },
            };
        },
    });

    pi.registerTool({
        name: "subagent_list",
        label: "List Subagents",
        description:
            "Return an immediate snapshot of queued and running subagent Jobs. Never use this tool to wait or poll for completion.",
        promptSnippet: "List active background subagent Jobs without waiting",
        promptGuidelines: [
            "Use subagent_list only for a requested status snapshot; never poll it while waiting for subagents.",
        ],
        parameters: Type.Object({}),
        async execute() {
            const jobs = getManager().list();
            const now = resolved.clock.now();
            const text = jobs.length
                ? jobs
                      .map(
                          (job) =>
                              `[${job.id}] ${job.state} ${seconds(now - (job.startedAt ?? job.createdAt))}: ${job.task.slice(0, 80)}`,
                      )
                      .join("\n")
                : "No active subagent Jobs.";
            return { content: [{ type: "text", text }], details: { jobs }, terminate: true };
        },
    });
}

export default function subagentExtension(pi: ExtensionAPI): void {
    registerSubagentExtension(pi);
}
