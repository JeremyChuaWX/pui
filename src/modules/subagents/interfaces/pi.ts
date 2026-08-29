import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Clock, SYSTEM_CLOCK } from "#shared/lib/clock.js";
import { composeBoundedOutput, RetainedOutputStore } from "#shared/lib/retained-output.js";
import { createBackgroundChannel } from "../background-channel.js";
import { BackgroundSubagentManager, type BackgroundTerminalResult } from "../background-manager.js";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_SCHEMA,
    BACKGROUND_SUBAGENT_VERSION,
    type BackgroundSubagentJobV1,
    parseBackgroundSubagentControl,
} from "../background-protocol.js";
import { getPiInvocation, PROCESS_CHILD_AGENT_SEMAPHORE, type SpawnChildAgent } from "../child-agent.js";
import { describeProfile, PROFILES, type SubagentProfile } from "../profiles/index.js";
import { type RunSubagentOptions, runSubagent, type SubagentRunResult } from "../runner.js";
import type { AbortableSemaphore } from "../semaphore.js";

const SpawnParams = Type.Object({
    prompt: Type.String({ description: "Task prompt for the child. Self-contained: the child sees nothing else." }),
    cwd: Type.String({
        description:
            "Working directory for the child process. Relative paths resolve from the parent working directory.",
    }),
    model: Type.Optional(Type.String({ description: "Optional model override for this Job." })),
    name: Type.Optional(Type.String({ description: "Optional short title shown in Job listings." })),
});
const BackgroundIdsParams = Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }) });
const BackgroundCheckParams = Type.Object({ id: Type.String() });

export interface SubagentExtensionDependencies {
    semaphore?: AbortableSemaphore;
    run?: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
    invocation?: typeof getPiInvocation;
    /** Spawns each child process; tests inject a scripted child. */
    spawn?: SpawnChildAgent;
    /** Time source and timer scheduler; tests inject a clock they advance by hand. */
    clock?: Clock;
    environment?: NodeJS.ProcessEnv;
}

/** Production collaborators, including the one process-wide concurrency owner. */
export function createDefaultSubagentDependencies(
    overrides: SubagentExtensionDependencies = {},
): Required<Omit<SubagentExtensionDependencies, "spawn">> & Pick<SubagentExtensionDependencies, "spawn"> {
    return {
        semaphore: overrides.semaphore ?? PROCESS_CHILD_AGENT_SEMAPHORE,
        run: overrides.run ?? runSubagent,
        invocation: overrides.invocation ?? getPiInvocation,
        ...(overrides.spawn ? { spawn: overrides.spawn } : {}),
        clock: overrides.clock ?? SYSTEM_CLOCK,
        environment: overrides.environment ?? process.env,
    };
}

export function registerSubagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}): void {
    const {
        semaphore,
        run,
        invocation: resolveInvocation,
        spawn,
        clock,
        environment,
    } = createDefaultSubagentDependencies(dependencies);
    const outputStore = new RetainedOutputStore({ prefix: "pi-subagent-", fileName: "output.md" });
    let shuttingDown = false;
    let sessionId = "unbound";
    const instanceId = crypto.randomUUID();
    let background: BackgroundSubagentManager;
    const route = () => ({ sessionId, instanceId });
    const channel = createBackgroundChannel({
        events: pi.events,
        eventChannel: BACKGROUND_SUBAGENT_CHANNEL,
        controlChannel: BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
        parseControl: parseBackgroundSubagentControl,
        controlRoute: (control) => ({ sessionId: control.sessionId, instanceId: control.instanceId }),
        envelope: (type, target, extra) => ({
            schema: BACKGROUND_SUBAGENT_SCHEMA,
            version: BACKGROUND_SUBAGENT_VERSION,
            ...target,
            type,
            ...extra,
        }),
        onControl: (control) => {
            if (!shuttingDown) void background.cancel([control.jobId]).catch(() => {});
        },
    });
    const emit = (job: BackgroundSubagentJobV1, type: "upsert" | "remove" = "upsert") =>
        channel.emit(type, { job }, route());
    // followUp queues behind the current turn and triggerTurn starts one when the agent is idle,
    // so neither the manager nor this Extension tracks whether the agent is busy.
    const deliver = (result: BackgroundTerminalResult) => {
        if (shuttingDown) return;
        const pathNote = result.fullOutputPath ? `\n\nFull output: ${result.fullOutputPath}` : "";
        pi.sendMessage(
            {
                customType: "subagent-result",
                content: `Background subagent ${result.title} (${result.id}) ${result.status}:\n\n${result.text}${pathNote}`,
                display: true,
                details: { id: result.id, title: result.title, status: result.status },
            },
            { deliverAs: "followUp", triggerTurn: true },
        );
    };
    background = new BackgroundSubagentManager({
        semaphore,
        run,
        invocation: resolveInvocation,
        ...(spawn ? { spawn } : {}),
        environment,
        clock,
        emit,
        deliver,
        outputStore,
    });
    pi.on("session_start", (_event, ctx) => {
        shuttingDown = false;
        outputStore.startSession();
        background.startSession();
        sessionId = ctx.sessionManager.getSessionId();
        channel.bind(route());
        channel.ready();
    });
    pi.on("session_shutdown", async () => {
        shuttingDown = true;
        await channel.shutdown(async () => {
            await background.shutdown();
            await outputStore.cleanup();
        });
    });

    const renderResults = (results: BackgroundTerminalResult[]) => {
        const content = results
            .map(
                (item) =>
                    `[${item.id}] ${item.title} — ${item.status}\n${item.text}${item.fullOutputPath ? `\nFull output: ${item.fullOutputPath}` : ""}`,
            )
            .join("\n\n");
        const truncation = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        return truncation.truncated
            ? composeBoundedOutput(
                  content,
                  { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
                  {
                      nonRetentionReason:
                          "the combined wait presentation is not retained; use each job's retained path when available",
                  },
              )
            : content;
    };
    /** One spawn tool per Profile. Each returns a Job id at once and queues behind the process-wide semaphore. */
    function registerSpawnTool(profile: SubagentProfile): void {
        pi.registerTool({
            name: profile.name,
            label: profile.label,
            description: `${profile.description} ${describeProfile(profile)}`,
            promptSnippet: profile.promptSnippet,
            promptGuidelines: profile.promptGuidelines,
            parameters: SpawnParams,
            async execute(_id, params, signal, _update, ctx) {
                const job = await background.spawn({ ...params, profile }, ctx.cwd, signal);
                return {
                    content: [{ type: "text", text: `Started ${profile.name} Job ${job.id} (${job.title}).` }],
                    details: job,
                };
            },
        });
    }
    for (const profile of PROFILES) registerSpawnTool(profile);
    pi.registerTool({
        name: "subagent_wait",
        label: "Wait for Background Subagents",
        description: "Wait for background jobs without cancelling them if this wait is aborted.",
        parameters: BackgroundIdsParams,
        async execute(_id, params, signal) {
            const results = await background.wait(params.ids, signal);
            return { content: [{ type: "text", text: renderResults(results) }], details: { results } };
        },
    });
    pi.registerTool({
        name: "subagent_check",
        label: "Check Background Subagent",
        description: "Inspect one background job without waiting or consuming result delivery.",
        parameters: BackgroundCheckParams,
        async execute(_id, params) {
            const job = background.check(params.id);
            return {
                content: [
                    {
                        type: "text",
                        text: `[${job.id}] ${job.title} — ${job.run.status}\n${job.run.outputPreview ?? job.run.error ?? "No output yet."}`,
                    },
                ],
                details: job,
            };
        },
    });
    pi.registerTool({
        name: "subagent_cancel",
        label: "Cancel Background Subagents",
        description: "Cancel queued or running background jobs and await terminal state.",
        parameters: BackgroundIdsParams,
        async execute(_id, params) {
            const jobs = await background.cancel(params.ids);
            return {
                content: [{ type: "text", text: jobs.map((job) => `[${job.id}] ${job.run.status}`).join("\n") }],
                details: { jobs },
            };
        },
    });
}

export default function subagentExtension(pi: ExtensionAPI): void {
    registerSubagentExtension(pi, createDefaultSubagentDependencies());
}
