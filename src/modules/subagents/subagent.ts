import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    type AgentSession,
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { JobUsage, Runner, RunResult } from "./protocol.js";

/** Session events that mean the child is still making progress. */
const ACTIVITY_EVENTS = new Set([
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "auto_retry_start",
    "compaction_start",
]);

export interface RunnerDependencies {
    resolveModel: (spec: string) => Model<Api> | undefined;
    createSession?: typeof createAgentSession;
}

/** Build a runner: one isolated in-process AgentSession per Job, disposed when done. */
export function createRunner(dependencies: RunnerDependencies): Runner {
    return async (config, signal, onActivity) => {
        const model = dependencies.resolveModel(config.model);
        if (!model) throw new Error(`Unknown model: ${config.model}`);
        if (signal.aborted) throw new Error("Cancelled before start.");

        const agentDir = getAgentDir();
        const loader = new DefaultResourceLoader({
            cwd: config.cwd,
            agentDir,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            ...(config.promptMode === "replace"
                ? { systemPrompt: config.systemPrompt }
                : { appendSystemPrompt: [config.systemPrompt] }),
        });
        await loader.reload();

        const createSession = dependencies.createSession ?? createAgentSession;
        const { session } = await createSession({
            cwd: config.cwd,
            agentDir,
            model,
            thinkingLevel: config.thinkingLevel,
            tools: [...config.tools],
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(config.cwd),
            settingsManager: SettingsManager.create(config.cwd, agentDir),
        });

        // Cancellation may have fired while the AgentSession was being built.
        if (signal.aborted) {
            session.dispose();
            throw new Error("Cancelled before start.");
        }
        const unsubscribe = session.subscribe((event) => {
            if (ACTIVITY_EVENTS.has(event.type)) onActivity();
        });
        const onAbort = () => {
            session.abort().catch(() => {});
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            await session.prompt(config.task, { expandPromptTemplates: false, source: "extension" });
            return collect(session);
        } finally {
            signal.removeEventListener("abort", onAbort);
            unsubscribe();
            session.dispose();
        }
    };
}

/** Use the last assistant text, or the newest earlier text when the last response had none. */
export function collect(session: Pick<AgentSession, "state">): RunResult {
    const assistants = session.state.messages.filter(
        (message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant",
    );
    const textOf = (message: Extract<AgentMessage, { role: "assistant" }>) =>
        message.content
            .filter(
                (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
                    content.type === "text",
            )
            .map((content) => content.text)
            .join("")
            .trim();
    const last = assistants.at(-1);
    let text = last ? textOf(last) : "";
    let partial = false;
    if (!text) {
        text = [...assistants].reverse().map(textOf).find(Boolean) ?? "";
        partial = true;
    }
    const usage = assistants.reduce<JobUsage>(
        (total, message) => ({
            input: total.input + (message.usage?.input ?? 0),
            output: total.output + (message.usage?.output ?? 0),
            totalTokens: total.totalTokens + (message.usage?.totalTokens ?? 0),
            cost: total.cost + (message.usage?.cost?.total ?? 0),
        }),
        { input: 0, output: 0, totalTokens: 0, cost: 0 },
    );
    return { text, partial, usage };
}
