import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBackgroundChannel } from "../shared/background-channel.js";
import {
    AGENT_NAMES,
    AGENT_SUMMARY,
    AGENTS,
    type ResolvedAgentName,
    resolveModel,
    resolveWorkingDirectory,
    workingDirectoryCandidate,
} from "../shared/presets.js";
import { formatTruncationNotice, RetainedOutputStore, truncateUtf8 } from "../shared/retained-output.js";
import { AbortableSemaphore, configuredSubagentConcurrency } from "../shared/semaphore.js";
import { errorMessage } from "../shared/validate.js";
import { BackgroundSubagentManager, type BackgroundTerminalResult } from "./background-manager.js";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_SCHEMA,
    BACKGROUND_SUBAGENT_VERSION,
    type BackgroundSubagentJobV1,
    parseBackgroundSubagentControl,
} from "./background-protocol.js";
import { createInitialSubagentDetails, type SubagentDetailsV1, updateSubagentDetails } from "./protocol.js";
import { runSubagentJob, synthesizeSubagentFailure } from "./run-job.js";
import { getPiInvocation, type RunSubagentOptions, runSubagent, type SubagentRunResult } from "./runner.js";

const UNGUIDED_AGENT_NAME = "generic" as const;

const BackgroundSpawnParams = Type.Object({
    prompt: Type.String(),
    cwd: Type.String(),
    agent: Type.Optional(StringEnum(AGENT_NAMES)),
    model: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
});
const BackgroundIdsParams = Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }) });
const BackgroundCheckParams = Type.Object({ id: Type.String() });
const BackgroundListParams = Type.Object({});

const SubagentParams = Type.Object({
    agent: Type.Optional(
        StringEnum(AGENT_NAMES, {
            description:
                "Fixed guided preset to use. Omit for an unguided, write-capable child using Pi's normal coding prompt.",
        }),
    ),
    prompt: Type.String({
        description: "Task prompt for the subagent.",
    }),
    cwd: Type.String({
        description:
            "Working directory for the subagent process. Relative paths resolve from the parent working directory.",
    }),
    model: Type.Optional(
        Type.String({
            description: "Optional model override. Omitted-agent calls otherwise use child Pi's default model.",
        }),
    ),
});

const processState = globalThis as typeof globalThis & {
    __piSubagentSemaphoreV1?: AbortableSemaphore;
};
const PROCESS_SEMAPHORE =
    processState.__piSubagentSemaphoreV1 ?? new AbortableSemaphore(configuredSubagentConcurrency());
if (!processState.__piSubagentSemaphoreV1) processState.__piSubagentSemaphoreV1 = PROCESS_SEMAPHORE;

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
        semaphore: overrides.semaphore ?? PROCESS_SEMAPHORE,
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

function presentTruncated(
    fullText: string,
    limits: { maxBytes: number; maxLines: number },
    retainedPath?: string,
    nonRetentionReason = "complete output retention was unavailable",
): string {
    const totalBytes = Buffer.byteLength(fullText, "utf8");
    const totalLines = fullText.length === 0 ? 0 : fullText.split("\n").length - (fullText.endsWith("\n") ? 1 : 0);
    let notice = formatTruncationNotice({
        outputBytes: 0,
        totalBytes,
        outputLines: 0,
        totalLines,
        ...(retainedPath ? { retainedPath } : { nonRetentionReason }),
    });
    let preview = truncateHead(fullText, { maxBytes: 0, maxLines: 0 });
    for (let attempt = 0; attempt < 3; attempt++) {
        const noticeBytes = Buffer.byteLength(notice, "utf8");
        if (limits.maxLines < 3 || noticeBytes > limits.maxBytes) return truncateUtf8(notice, limits.maxBytes).content;
        preview = truncateHead(fullText, {
            maxBytes: Math.max(0, limits.maxBytes - noticeBytes - 2),
            maxLines: limits.maxLines - 2,
        });
        const next = formatTruncationNotice({
            outputBytes: preview.outputBytes,
            totalBytes,
            outputLines: preview.outputLines,
            totalLines,
            ...(retainedPath ? { retainedPath } : { nonRetentionReason }),
        });
        if (next === notice) return preview.content ? `${preview.content}\n\n${notice}` : notice;
        notice = next;
    }
    return truncateUtf8(notice, limits.maxBytes).content;
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
            ? presentTruncated(
                  content,
                  { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
                  undefined,
                  "the combined wait presentation is not retained; use each job's retained path when available",
              )
            : content;
    };
    pi.registerTool({
        name: "subagent_spawn",
        label: "Spawn Background Subagent",
        description: "Start an isolated Pi subagent in the background and return its job id immediately.",
        promptSnippet: "Start delegated work in the background",
        promptGuidelines: [
            "After subagent_spawn, continue useful parent work; use subagent_wait only when progress depends on the result.",
        ],
        parameters: BackgroundSpawnParams,
        async execute(_id, params, signal, _update, ctx) {
            const job = await background.spawn(params, ctx.cwd, signal);
            return {
                content: [{ type: "text", text: `Started background subagent ${job.id} (${job.title}).` }],
                details: job,
            };
        },
    });
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
    pi.registerTool({
        name: "subagent_list",
        label: "List Background Subagents",
        description: "List jobs tracked by this extension instance.",
        parameters: BackgroundListParams,
        async execute() {
            const jobs = background.list();
            return {
                content: [
                    {
                        type: "text",
                        text: jobs.length
                            ? jobs.map((job) => `[${job.id}] ${job.title} — ${job.run.status}`).join("\n")
                            : "No background subagents.",
                    },
                ],
                details: { jobs },
            };
        },
    });

    pi.registerTool<typeof SubagentParams, SubagentDetailsV1>({
        name: "subagent",
        label: "Subagent",
        description:
            "Spawn an isolated Pi subagent for delegated coding work. " +
            `Available modes: ${AGENT_SUMMARY}. ` +
            "Omitting agent uses no bundled agent prompt or model and leaves the input prompt to steer a write-capable child. " +
            "An optional model argument overrides model selection. Output is capped at 50KB or 2000 lines.",
        promptSnippet:
            "Delegate implementation, review, debugging, testing, or read-only exploration to an isolated Pi subagent.",
        promptGuidelines: [
            "Use subagent instead of bash launching headless Pi when the user asks to delegate work to a worker, implementer, reviewer, or another agent.",
            'Omit subagent\'s agent argument for unguided general coding with read/write tools; select "worker" for bundled coding guidance or "explore" for read-only reconnaissance.',
            "Give subagent a focused, self-contained prompt and the exact working directory because child context files, skills, and extensions are disabled.",
            "Issue multiple independent subagent calls in the same turn when their tasks can run in parallel.",
            "Omit subagent's model argument unless a model override is specifically useful.",
        ],
        parameters: SubagentParams,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const agentName: ResolvedAgentName = params.agent ?? UNGUIDED_AGENT_NAME;
            const agent = AGENTS[agentName];
            const model = resolveModel(agent, params.model, environment);
            const cwdCandidate = workingDirectoryCandidate(params.cwd, ctx.cwd);
            let details = createInitialSubagentDetails({
                id: toolCallId,
                agent: agentName,
                model: model ?? "default",
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
                    agent,
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
                ? presentTruncated(
                      outcome.delivered,
                      { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
                      outcome.fullOutputPath,
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
