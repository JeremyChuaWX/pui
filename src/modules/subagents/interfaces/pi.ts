import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { composeBoundedOutput, RetainedOutputStore, truncateUtf8 } from "#shared/lib/retained-output.js";
import { errorMessage } from "#shared/lib/validate.js";
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
import { getPiInvocation, PROCESS_CHILD_AGENT_SEMAPHORE } from "../child-agent.js";
import {
    describeProfile,
    PROFILE_NAMES,
    PROFILES,
    PROFILES_BY_NAME,
    resolveProfileModel,
    type SubagentProfile,
} from "../profiles/index.js";
import { createInitialSubagentDetails, type SubagentDetailsV1, updateSubagentDetails } from "../protocol.js";
import { runSubagentJob, synthesizeSubagentFailure } from "../run-job.js";
import { type RunSubagentOptions, runSubagent, type SubagentRunResult } from "../runner.js";
import type { AbortableSemaphore } from "../semaphore.js";
import { resolveWorkingDirectory, workingDirectoryCandidate } from "../working-directory.js";

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

const SubagentParams = Type.Object({
    agent: StringEnum(PROFILE_NAMES, {
        description: `Profile to run the child under: ${PROFILE_NAMES.join(" or ")}.`,
    }),
    prompt: Type.String({
        description: "Task prompt for the subagent.",
    }),
    cwd: Type.String({
        description:
            "Working directory for the subagent process. Relative paths resolve from the parent working directory.",
    }),
    model: Type.Optional(Type.String({ description: "Optional model override for this call." })),
});

export interface SubagentExtensionDependencies {
    semaphore?: AbortableSemaphore;
    run?: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
    invocation?: typeof getPiInvocation;
    now?: () => number;
    environment?: NodeJS.ProcessEnv;
}

/** Production collaborators, including the one process-wide concurrency owner. */
export function createDefaultSubagentDependencies(
    overrides: SubagentExtensionDependencies = {},
): Required<SubagentExtensionDependencies> {
    return {
        semaphore: overrides.semaphore ?? PROCESS_CHILD_AGENT_SEMAPHORE,
        run: overrides.run ?? runSubagent,
        invocation: overrides.invocation ?? getPiInvocation,
        now: overrides.now ?? Date.now,
        environment: overrides.environment ?? process.env,
    };
}

function lifecycleText(details: SubagentDetailsV1): string {
    const { run } = details;
    if (run.status === "queued") return `${run.agent} subagent is queued...`;
    if (run.status === "starting") return `${run.agent} subagent is starting...`;
    if (run.status === "running") return `${run.agent} subagent is running...`;
    if (run.status === "succeeded") return `${run.agent} subagent completed.`;
    return run.error || `${run.agent} subagent ${run.status}.`;
}

function combineAbortSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
    return first ? AbortSignal.any([first, second]) : second;
}

export function registerSubagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}): void {
    const {
        semaphore,
        run,
        invocation: resolveInvocation,
        now,
        environment,
    } = createDefaultSubagentDependencies(dependencies);
    let shutdownController = new AbortController();
    const outputStore = new RetainedOutputStore({ prefix: "pi-subagent-", fileName: "output.md" });
    const failedDetails = new Map<string, SubagentDetailsV1>();
    let shuttingDown = false;
    let sessionId = "unbound";
    const instanceId = crypto.randomUUID();
    let idle = true;
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
        environment,
        now,
        emit,
        deliver,
        isIdle: () => idle,
        outputStore,
    });
    pi.on("session_start", (_event, ctx) => {
        shuttingDown = false;
        if (shutdownController.signal.aborted) shutdownController = new AbortController();
        outputStore.startSession();
        background.startSession();
        sessionId = ctx.sessionManager.getSessionId();
        idle = ctx.isIdle();
        channel.bind(route());
        channel.ready();
    });
    pi.on("agent_start", () => {
        idle = false;
    });
    pi.on("agent_settled", () => {
        idle = true;
        background.flushDeferred();
    });

    pi.on("tool_result", (event) => {
        const saved = failedDetails.get(event.toolCallId);
        if (!saved) return;
        failedDetails.delete(event.toolCallId);
        return { details: saved };
    });

    pi.on("session_shutdown", async () => {
        shuttingDown = true;
        shutdownController.abort();
        failedDetails.clear();
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
    pi.registerTool<typeof SubagentParams, SubagentDetailsV1>({
        name: "subagent",
        label: "Subagent",
        description:
            "Spawn an isolated Pi subagent under a Profile and block until it finishes. " +
            PROFILES.map((profile) => `${profile.name}: ${describeProfile(profile)}`).join(" ") +
            " Output is capped at 50KB or 2000 lines.",
        promptSnippet: "Delegate coding work or read-only exploration to an isolated Pi subagent and wait for it.",
        promptGuidelines: [
            "Prefer the explorer and worker spawn tools; use subagent only when the result is needed before anything else can happen.",
            "Give subagent a focused, self-contained prompt and the exact working directory because child context files, skills, and extensions are disabled.",
            "Omit subagent's model argument unless a model override is specifically useful.",
        ],
        parameters: SubagentParams,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const profile = PROFILES_BY_NAME[params.agent];
            const model = resolveProfileModel(profile, params.model, environment);
            const cwdCandidate = workingDirectoryCandidate(params.cwd, ctx.cwd);
            let details = createInitialSubagentDetails({
                id: toolCallId,
                agent: profile.name,
                model,
                cwd: cwdCandidate,
                now: now(),
            });
            const combinedSignal = combineAbortSignals(signal, shutdownController.signal);

            const publish = (next: SubagentDetailsV1) => {
                details = next;
                try {
                    onUpdate?.({
                        content: [{ type: "text", text: lifecycleText(next) }],
                        details: next,
                    });
                } catch {
                    // A presentation callback must not change process or persistence semantics.
                }
            };

            let cwd: string;
            try {
                cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
            } catch (error) {
                publish(synthesizeSubagentFailure(details, "failed", errorMessage(error), now()));
                if (!shuttingDown) failedDetails.set(toolCallId, details);
                throw new Error(details.run.error || errorMessage(error), { cause: error });
            }
            details = updateSubagentDetails(details, { cwd }, now());

            const outcome = await runSubagentJob(
                { semaphore, run, invocation: resolveInvocation, now },
                {
                    details,
                    profile,
                    model,
                    prompt: params.prompt,
                    cwd,
                    signal: combinedSignal,
                    publish,
                    spill: { store: outputStore, maxLines: DEFAULT_MAX_LINES },
                },
            );
            details = outcome.details;

            if (details.run.status !== "succeeded") {
                if (!shuttingDown) failedDetails.set(toolCallId, details);
                throw new Error(details.run.error || `Subagent ${details.run.status}.`, {
                    cause: outcome.failure,
                });
            }

            const { truncation } = outcome;
            const resultText = truncation.truncated
                ? composeBoundedOutput(
                      outcome.delivered,
                      { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
                      outcome.fullOutputPath
                          ? { retainedPath: outcome.fullOutputPath }
                          : { nonRetentionReason: "complete output retention was unavailable" },
                  )
                : truncation.content;
            details = updateSubagentDetails(
                details,
                { outputPreview: truncateUtf8(outcome.delivered, 4 * 1024).content },
                now(),
            );

            return {
                content: [{ type: "text", text: resultText }],
                details,
            };
        },
    });
}

export default function subagentExtension(pi: ExtensionAPI): void {
    registerSubagentExtension(pi, createDefaultSubagentDependencies());
}
