import * as fs from "node:fs";
import * as path from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorkflowAgentExecutor, defaultWorkflowPolicy, isHeadlessWorkflowSession } from "./agent-executor.js";
import { FileWorkflowApprovalStore, type WorkflowApprovalStore, workflowApprovalKey } from "./approval.js";
import {
    createWorkflowBackend,
    preflightWorkflow,
    type WorkflowBackend,
    type WorkflowBackendOptions,
} from "./backend.js";
import {
    BACKGROUND_WORKFLOW_CHANNEL,
    BACKGROUND_WORKFLOW_CONTROL_CHANNEL,
    BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL,
    BACKGROUND_WORKFLOW_SCHEMA,
    BACKGROUND_WORKFLOW_VERSION,
    parseBackgroundWorkflowControl,
} from "./background-protocol.js";
import { WorkflowRunManager } from "./manager.js";
import { errorMessage } from "./protocol.js";
import { WorkflowRunStorage } from "./run-storage.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { findRepositoryRoot, hasWorkflowMetadata, parseWorkflowMetadata, readWorkflowFile } from "./source.js";
import workflowWritingDocumentation from "./writing-workflows.md" with { type: "text" };

export function isWorkflowWritingRequest(prompt: string): boolean {
    const words = prompt.toLowerCase().match(/[a-z]+/g) ?? [];
    return words.some(
        (word, verbIndex) =>
            (word === "write" || word === "create") &&
            !["about", "doc", "docs", "documentation"].includes(words[verbIndex + 1] ?? "") &&
            words.some(
                (candidate, workflowIndex) =>
                    (candidate === "workflow" || candidate === "workflows") && Math.abs(workflowIndex - verbIndex) <= 6,
            ),
    );
}

const WorkflowParams = Type.Object({
    script: Type.Optional(
        Type.String({
            description:
                "Exact inline TypeScript orchestration script to approve and run (JavaScript is valid TypeScript).",
        }),
    ),
    path: Type.Optional(
        Type.String({
            description:
                "Explicit .ts workflow file exporting a default function. Exactly one of script or path is required.",
        }),
    ),
    args: Type.Optional(Type.Unknown()),
});
function parseWorkflowCommand(text: string): { requestedPath: string; argsText?: string } | undefined {
    const input = text.trim();
    if (!input) return undefined;
    const quote = input[0];
    if (quote !== '"' && quote !== "'") {
        const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(input);
        return match ? { requestedPath: match[1], argsText: match[2] } : undefined;
    }
    const end = input.indexOf(quote, 1);
    if (end < 0 || (input[end + 1] !== undefined && !/\s/.test(input[end + 1])))
        throw new Error("Quoted workflow paths must end with a matching quote before JSON arguments.");
    const requestedPath = input.slice(1, end);
    if (!requestedPath) return undefined;
    const argsText = input.slice(end + 1).trim();
    return { requestedPath, ...(argsText ? { argsText } : {}) };
}

export interface WorkflowExtensionDependencies {
    backend?: WorkflowBackend;
    backendOptions?: Omit<WorkflowBackendOptions, "eventSink">;
    environment?: NodeJS.ProcessEnv;
    instanceId?: string;
    approvalStore?: WorkflowApprovalStore;
}

export function registerWorkflowExtension(pi: ExtensionAPI, dependencies: WorkflowExtensionDependencies = {}): void {
    const environment = dependencies.environment ?? process.env;
    const instanceId = dependencies.instanceId ?? crypto.randomUUID();
    const approvalStore = dependencies.approvalStore ?? new FileWorkflowApprovalStore();
    const defaultExecutor = createWorkflowAgentExecutor(environment);
    const backend =
        dependencies.backend ??
        createWorkflowBackend({
            ...dependencies.backendOptions,
            agentExecutor: dependencies.backendOptions?.agentExecutor ?? defaultExecutor,
            cooperativeExecutor: dependencies.backendOptions?.agentExecutor
                ? dependencies.backendOptions.cooperativeExecutor
                : true,
            storage: dependencies.backendOptions?.storage ?? new WorkflowRunStorage(),
            policy: dependencies.backendOptions?.policy ?? defaultWorkflowPolicy(environment),
        });
    const lifecycle = new SessionLifecycle();
    const emitEnvelope = (
        type: "ready" | "reset" | "upsert",
        extra: object = {},
        route = { sessionId: lifecycle.sessionId, cwd: lifecycle.cwd },
    ) =>
        pi.events?.emit(BACKGROUND_WORKFLOW_CHANNEL, {
            schema: BACKGROUND_WORKFLOW_SCHEMA,
            version: BACKGROUND_WORKFLOW_VERSION,
            sessionId: route.sessionId,
            instanceId,
            cwd: route.cwd,
            type,
            ...extra,
        });
    const manager = new WorkflowRunManager({
        backend,
        emit: (run) => emitEnvelope("upsert", { run }, { sessionId: run.sessionId, cwd: run.cwd }),
        shouldDeliver: (run) => !isHeadlessWorkflowSession(run.sessionId),
        deliver: (run, result) =>
            pi.sendMessage(
                {
                    customType: "workflow-result",
                    content: `Workflow ${run.name} (${run.id}) ${run.status}.${result ? `\n\n${result}` : run.error ? `\n\n${run.error}` : ""}`,
                    display: true,
                    details: { id: run.id, status: run.status },
                },
                { deliverAs: "followUp", triggerTurn: true },
            ),
    });
    pi.on("before_agent_start", (event) => {
        if (!isWorkflowWritingRequest(event.prompt)) return;
        return {
            systemPrompt: `${event.systemPrompt}\n\n${workflowWritingDocumentation.trim()}`,
        };
    });
    pi.on("session_start", async (_event, ctx) => {
        const epoch = lifecycle.beginEpoch();
        const route = {
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: await fs.promises.realpath(ctx.cwd),
        };
        if (epoch.stale()) return;
        lifecycle.bind(route);
        lifecycle.setControlSubscription(
            pi.events?.on(BACKGROUND_WORKFLOW_CONTROL_CHANNEL, (payload) => {
                if (epoch.stale()) return;
                const control = parseBackgroundWorkflowControl(payload, { ...route, instanceId });
                if (!control) return;
                void (async () => {
                    try {
                        const result = await manager.control(control.runId, control.action, control.agentId);
                        if (epoch.stale()) return;
                        pi.events?.emit(BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL, {
                            schema: "pi.workflow.background.control.result",
                            version: 1,
                            ...route,
                            instanceId,
                            requestId: control.requestId,
                            ok: true,
                            ...(result?.runId ? { linkedRunId: result.runId } : {}),
                        });
                    } catch (error) {
                        if (epoch.stale()) return;
                        pi.events?.emit(BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL, {
                            schema: "pi.workflow.background.control.result",
                            version: 1,
                            ...route,
                            instanceId,
                            requestId: control.requestId,
                            ok: false,
                            error: errorMessage(error).slice(0, 2_000),
                        });
                    }
                })();
            }),
        );
        let recovered: Awaited<ReturnType<WorkflowRunManager["initialize"]>> | undefined;
        await lifecycle.enqueue(async () => {
            if (epoch.stale()) return;
            recovered = await manager.initialize(route.cwd);
        });
        if (epoch.stale() || !recovered) return;
        emitEnvelope("ready", {}, route);
        for (const run of recovered.filter(
            (item) =>
                !isHeadlessWorkflowSession(item.sessionId) &&
                !["succeeded", "failed", "cancelled", "timed_out"].includes(item.status),
        )) {
            if (epoch.stale()) return;
            try {
                const choice = await ctx.ui.select(
                    `Interrupted workflow: ${run.name}`,
                    ["Resume", "Inspect", "Stop", "Later"],
                    { signal: epoch.signal },
                );
                if (epoch.stale()) return;
                if (choice === "Resume") await backend.recover?.(run.id);
                else if (choice === "Inspect") ctx.ui.notify(JSON.stringify(backend.inspect(run.id).run), "info");
                else if (choice === "Stop") await backend.control(run.id, "stop");
            } catch (error) {
                if (epoch.stale()) return;
                ctx.ui.notify(`Could not recover workflow ${run.name}: ${errorMessage(error)}`, "warning");
            }
        }
        if (epoch.stale()) return;
        for (const run of manager.list())
            if (run.sessionId === route.sessionId && run.cwd === route.cwd) emitEnvelope("upsert", { run }, route);
    });
    pi.on("session_shutdown", async () => {
        const epoch = lifecycle.endEpoch();
        const route = { sessionId: lifecycle.sessionId, cwd: lifecycle.cwd };
        await lifecycle.enqueue(() => manager.shutdown());
        if (!epoch.stale()) emitEnvelope("reset", {}, route);
    });
    const authorize = async (key: string, title: string, body: string, ui: Partial<ExtensionUIContext>) => {
        if (await approvalStore.has(key)) return;
        if (!ui.confirm || !(await ui.confirm(title, body))) throw new Error("Workflow launch was denied.");
        await approvalStore.add(key);
    };
    const launchFile = async (requestedPath: string, args: unknown, ctx: ExtensionContext) => {
        const launch = lifecycle.launchContext();
        const canonical = await fs.promises.realpath(ctx.cwd);
        const source = await readWorkflowFile(canonical, requestedPath);
        const repositoryRoot = await findRepositoryRoot(canonical);
        const project = repositoryRoot ?? canonical;
        const relative = path.relative(project, source.path);
        const insideProject = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        if (repositoryRoot && insideProject && !ctx.isProjectTrusted?.())
            throw new Error(`Project workflow "${source.name}" is not trusted. Trust the project before running it.`);
        const preview = preflightWorkflow(source.script, "function");
        await authorize(
            workflowApprovalKey(project, source.path, source.script),
            `Approve workflow file: ${source.name}`,
            `Source: ${source.path}\nPhases: ${preview.phases.join(", ") || "dynamic"}\nVisible agent calls: ${preview.agents}\nVisible shell calls: ${preview.shells}\n\n${source.script}`,
            ctx.ui,
        );
        if (!launch.unchanged(canonical))
            throw new Error("Workflow launch was cancelled because the active session changed during approval.");
        return manager.launch(
            {
                name: source.name,
                script: source.script,
                entrypoint: "function",
                args,
                sessionId: launch.sessionId,
                cwd: canonical,
            },
            launch.signal,
        );
    };
    pi.registerCommand("workflow", {
        description: "Run a workflow file",
        handler: async (text: string, ctx: ExtensionCommandContext) => {
            const parsed = parseWorkflowCommand(text);
            if (!parsed) {
                ctx.ui.notify("Usage: /workflow <path> [JSON args]", "warning");
                return;
            }
            let args: unknown;
            if (parsed.argsText) {
                try {
                    args = JSON.parse(parsed.argsText);
                } catch {
                    throw new Error("Workflow arguments must be valid JSON.");
                }
            }
            const launched = await launchFile(parsed.requestedPath, args, ctx);
            ctx.ui.notify(`Started workflow ${launched.runId}.`, "info");
        },
    });
    pi.registerTool({
        name: "workflow",
        label: "Workflow",
        description:
            "Approve and launch either an inline TypeScript script or an explicit .ts file exporting a workflow function (exactly one). Workflows can orchestrate agents and run CLI commands with shell().",
        parameters: WorkflowParams,
        async execute(_id, params, _signal, _update, ctx) {
            const hasScript = params.script !== undefined;
            const hasPath = params.path !== undefined;
            if (hasScript === hasPath) throw new Error("Provide exactly one of inline script or workflow file path.");
            if (params.path !== undefined) {
                const launched = await launchFile(params.path, params.args, ctx);
                return {
                    content: [{ type: "text", text: `Started workflow file ${params.path} (${launched.runId}).` }],
                    details: { schema: "pi.workflow.launch", version: 1, runId: launched.runId },
                };
            }
            const script = params.script;
            if (script === undefined) throw new Error("Provide exactly one of inline script or workflow file path.");
            const preview = preflightWorkflow(script);
            const ui = ctx.ui;
            const launch = lifecycle.launchContext();
            const canonical = await fs.promises.realpath(ctx.cwd);
            const project = (await findRepositoryRoot(canonical)) ?? canonical;
            let inlineName = "Inline workflow";
            if (hasWorkflowMetadata(script)) inlineName = parseWorkflowMetadata(script, "inline workflow").name;
            await authorize(
                workflowApprovalKey(project, inlineName, script),
                "Run inline workflow",
                `Phases: ${preview.phases.join(", ") || "dynamic"}\nVisible agent calls: ${preview.agents}\nVisible shell calls: ${preview.shells}\n\n${script}`,
                ui,
            );
            if (!launch.unchanged(canonical))
                throw new Error("Workflow launch was cancelled because the active session changed during approval.");
            const launched = await manager.launch(
                {
                    name: inlineName,
                    script,
                    args: params.args,
                    sessionId: launch.sessionId,
                    cwd: canonical,
                },
                launch.signal,
            );
            return {
                content: [
                    {
                        type: "text",
                        text: `Started background workflow ${launched.runId}. Use workflow controls or inspect the generic completion message.`,
                    },
                ],
                details: { schema: "pi.workflow.launch", version: 1, runId: launched.runId, preflight: preview },
            };
        },
    });
}
export default function workflowExtension(pi: ExtensionAPI): void {
    registerWorkflowExtension(pi);
}
