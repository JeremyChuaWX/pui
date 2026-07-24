import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundSubagentManager, type BackgroundTerminalResult } from "./background-manager.js";
import {
    BACKGROUND_SUBAGENT_CHANNEL,
    BACKGROUND_SUBAGENT_CONTROL_CHANNEL,
    BACKGROUND_SUBAGENT_SCHEMA,
    BACKGROUND_SUBAGENT_VERSION,
    type BackgroundSubagentJobV1,
    parseBackgroundSubagentControl,
} from "./background-protocol.js";
import {
    AGENT_NAMES,
    AGENT_SUMMARY,
    AGENTS,
    childArgs,
    type ResolvedAgentName,
    resolveModel,
    resolveWorkingDirectory,
    workingDirectoryCandidate,
} from "./presets.js";
import {
    appendSubagentActivity,
    createInitialSubagentDetails,
    createTerminalSubagentDetails,
    isTerminalSubagentStatus,
    type SubagentDetailsV1,
    type SubagentStatus,
    truncateUtf8,
    updateSubagentDetails,
} from "./protocol.js";
import { getPiInvocation, type RunSubagentOptions, runSubagent, type SubagentRunResult } from "./runner.js";
import { AbortableSemaphore, configuredSubagentConcurrency, type SemaphoreRelease } from "./semaphore.js";

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
const ERROR_PREVIEW_BYTES = 8 * 1024;

export interface SubagentExtensionDependencies {
    semaphore?: AbortableSemaphore;
    run?: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
    invocation?: typeof getPiInvocation;
    now?: () => number;
    environment?: NodeJS.ProcessEnv;
}

async function saveFullOutput(output: string): Promise<string | undefined> {
    try {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
        await fs.promises.chmod(directory, 0o700);
        const outputPath = path.join(directory, "output.md");
        await fs.promises.writeFile(outputPath, output, { encoding: "utf8", mode: 0o600 });
        return outputPath;
    } catch {
        return undefined;
    }
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export { getPiInvocation } from "./runner.js";

export function registerSubagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}): void {
    const semaphore = dependencies.semaphore ?? PROCESS_SEMAPHORE;
    const run = dependencies.run ?? runSubagent;
    const resolveInvocation = dependencies.invocation ?? getPiInvocation;
    const now = dependencies.now ?? Date.now;
    const environment = dependencies.environment ?? process.env;
    const shutdownController = new AbortController();
    const failedDetails = new Map<string, SubagentDetailsV1>();
    let shuttingDown = false;
    let sessionId = "unbound";
    const instanceId = crypto.randomUUID();
    let idle = true;
    const emitBus = (payload: object) => pi.events?.emit(BACKGROUND_SUBAGENT_CHANNEL, payload);
    const emit = (job: BackgroundSubagentJobV1, type: "upsert" | "remove" = "upsert") => {
        emitBus({
            schema: BACKGROUND_SUBAGENT_SCHEMA,
            version: BACKGROUND_SUBAGENT_VERSION,
            sessionId,
            instanceId,
            type,
            job,
        });
    };
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
    const background = new BackgroundSubagentManager({
        semaphore,
        run,
        invocation: resolveInvocation,
        environment,
        now,
        emit,
        deliver,
        isIdle: () => idle,
    });
    let unsubscribeControl: (() => void) | undefined;

    pi.on("session_start", (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        idle = ctx.isIdle();
        unsubscribeControl?.();
        unsubscribeControl = pi.events?.on(BACKGROUND_SUBAGENT_CONTROL_CHANNEL, (payload) => {
            const control = parseBackgroundSubagentControl(payload);
            if (!control || shuttingDown || control.sessionId !== sessionId || control.instanceId !== instanceId)
                return;
            void background.cancel([control.jobId]).catch(() => {});
        });
        emitBus({
            schema: BACKGROUND_SUBAGENT_SCHEMA,
            version: BACKGROUND_SUBAGENT_VERSION,
            sessionId,
            instanceId,
            type: "ready",
        });
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
        unsubscribeControl?.();
        shutdownController.abort();
        failedDetails.clear();
        await background.shutdown();
        emitBus({
            schema: BACKGROUND_SUBAGENT_SCHEMA,
            version: BACKGROUND_SUBAGENT_VERSION,
            sessionId,
            instanceId,
            type: "reset",
        });
    });

    const renderResults = (results: BackgroundTerminalResult[]) => {
        const content = results
            .map(
                (item) =>
                    `[${item.id}] ${item.title} — ${item.status}\n${item.text}${item.fullOutputPath ? `\nFull output: ${item.fullOutputPath}` : ""}`,
            )
            .join("\n\n");
        const notice =
            "\n\n[Combined wait output truncated; use the per-job full output paths above or in result details.]";
        const truncation = truncateHead(content, {
            maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
            maxLines: DEFAULT_MAX_LINES - 2,
        });
        return truncation.truncated ? `${truncation.content}${notice}` : content;
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
            let release: SemaphoreRelease | undefined;

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

            const settleSetupFailure = (status: Extract<SubagentStatus, "failed" | "cancelled">, message: string) => {
                details = appendSubagentActivity(
                    details,
                    { timestamp: now(), kind: "diagnostic", title: truncateUtf8(message, 512).content, isError: true },
                    now(),
                );
                publish(
                    createTerminalSubagentDetails(
                        details,
                        { status, error: truncateUtf8(message, ERROR_PREVIEW_BYTES).content },
                        now(),
                    ),
                );
            };

            try {
                let cwd: string;
                try {
                    cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
                } catch (error) {
                    settleSetupFailure("failed", errorMessage(error));
                    throw error;
                }
                details = updateSubagentDetails(details, { cwd }, now());
                details = appendSubagentActivity(
                    details,
                    { timestamp: now(), kind: "diagnostic", title: "Queued for a child Pi process" },
                    now(),
                );
                publish(details);

                try {
                    release = await semaphore.acquire(combinedSignal);
                } catch (error) {
                    settleSetupFailure("cancelled", "Subagent was cancelled while queued.");
                    throw error;
                }
                if (combinedSignal.aborted) {
                    settleSetupFailure("cancelled", "Subagent was cancelled before it started.");
                    throw new Error("Subagent was cancelled before it started.");
                }

                const startedAt = now();
                details = updateSubagentDetails(
                    details,
                    { status: "starting", phase: "spawning", startedAt },
                    startedAt,
                );
                details = appendSubagentActivity(
                    details,
                    { timestamp: startedAt, kind: "diagnostic", title: "Starting child Pi" },
                    startedAt,
                );
                publish(details);

                const invocation = resolveInvocation(childArgs(agent, model, params.prompt));
                const execution = await run({
                    details,
                    command: invocation.command,
                    args: invocation.args,
                    cwd,
                    timeoutMs: agent.timeoutMs,
                    signal: combinedSignal,
                    onSnapshot: publish,
                });
                details = execution.details;

                if (details.run.status !== "succeeded") {
                    if (!shuttingDown) failedDetails.set(toolCallId, details);
                    throw new Error(details.run.error || `Subagent ${details.run.status}.`);
                }

                const visibleOutput = execution.output || "(no output)";
                const truncation = truncateHead(visibleOutput, {
                    maxLines: DEFAULT_MAX_LINES,
                    maxBytes: DEFAULT_MAX_BYTES,
                });
                const fullOutputPath = truncation.truncated ? await saveFullOutput(visibleOutput) : undefined;
                let resultText = truncation.content;
                if (truncation.truncated) {
                    resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
                    if (fullOutputPath) resultText += ` Full output saved to: ${fullOutputPath}`;
                    resultText += "]";
                }
                details = updateSubagentDetails(
                    details,
                    {
                        outputPreview: truncateUtf8(visibleOutput, 4 * 1024).content,
                        ...(fullOutputPath ? { fullOutputPath } : {}),
                    },
                    now(),
                );

                return {
                    content: [{ type: "text", text: resultText }],
                    details,
                };
            } catch (error) {
                if (!isTerminalSubagentStatus(details.run.status)) {
                    const cancelled = combinedSignal.aborted;
                    settleSetupFailure(cancelled ? "cancelled" : "failed", errorMessage(error));
                }
                if (!shuttingDown) failedDetails.set(toolCallId, details);
                throw new Error(details.run.error || errorMessage(error), { cause: error });
            } finally {
                release?.();
            }
        },
    });
}

export default function subagentExtension(pi: ExtensionAPI): void {
    registerSubagentExtension(pi);
}
