import * as fs from "node:fs";
import * as path from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENTS, childArgs, type ResolvedAgentName, resolveModel } from "../subagent/presets.js";
import { createInitialSubagentDetails } from "../subagent/protocol.js";
import { getPiInvocation, runSubagent } from "../subagent/runner.js";
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
import { WorkflowRunStorage } from "./run-storage.js";
import { findRepositoryRoot, parseWorkflowMetadata, readWorkflowFile } from "./source.js";

const WorkflowParams = Type.Object({
    script: Type.Optional(
        Type.String({ description: "Exact inline JavaScript orchestration script to approve and run." }),
    ),
    path: Type.Optional(
        Type.String({ description: "Explicit workflow file path. Exactly one of script or path is required." }),
    ),
    args: Type.Optional(Type.Unknown()),
});
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
    const defaultExecutor: WorkflowBackendOptions["agentExecutor"] = async (request) => {
        const role = request.role as ResolvedAgentName;
        const preset = AGENTS[role];
        if (!preset) throw new Error(`Agent role is not allowed by host policy: ${request.role}`);
        const model = resolveModel(preset, request.model, environment);
        const prompt = request.schema
            ? `${request.prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.schema)}`
            : request.prompt;
        const invocation = getPiInvocation(childArgs(preset, model, prompt));
        const result = await runSubagent({
            details: createInitialSubagentDetails({
                id: crypto.randomUUID(),
                agent: role,
                model: model ?? "default",
                cwd: request.cwd,
            }),
            command: invocation.command,
            args: invocation.args,
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
            signal: request.signal,
        });
        if (result.details.run.status !== "succeeded")
            throw new Error(result.details.run.error ?? `Child Pi ${result.details.run.status}.`);
        let value: unknown = result.output;
        if (request.schema) {
            try {
                value = JSON.parse(result.output);
            } catch {
                throw new Error("Child Pi returned invalid structured JSON.");
            }
        }
        return { value, usage: result.details.run.usage };
    };
    const backend =
        dependencies.backend ??
        createWorkflowBackend({
            ...dependencies.backendOptions,
            agentExecutor: dependencies.backendOptions?.agentExecutor ?? defaultExecutor,
            cooperativeExecutor: dependencies.backendOptions?.agentExecutor
                ? dependencies.backendOptions.cooperativeExecutor
                : true,
            storage: dependencies.backendOptions?.storage ?? new WorkflowRunStorage(),
            policy: dependencies.backendOptions?.policy ?? {
                roles: ["generic", "worker", "explore"],
                resolveModel: (role, requested) =>
                    resolveModel(AGENTS[role as ResolvedAgentName], requested, environment),
            },
        });
    let sessionId = "unbound",
        cwd = "",
        lifecycleGeneration = 0,
        recoveryAbort: AbortController | undefined,
        initializationQueue: Promise<void> = Promise.resolve(),
        unsubscribeControl: (() => void) | undefined,
        manager: WorkflowRunManager;
    const emitEnvelope = (
        type: "ready" | "reset" | "upsert" | "remove",
        extra: object = {},
        route = { sessionId, cwd },
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
    manager = new WorkflowRunManager({
        backend,
        emit: (run) => emitEnvelope("upsert", { run }, { sessionId: run.sessionId, cwd: run.cwd }),
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
    pi.on("session_start", async (_event, ctx) => {
        const generation = ++lifecycleGeneration;
        recoveryAbort?.abort();
        const abort = new AbortController();
        recoveryAbort = abort;
        const route = {
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: await fs.promises.realpath(ctx.cwd),
        };
        if (generation !== lifecycleGeneration || abort.signal.aborted) return;
        sessionId = route.sessionId;
        cwd = route.cwd;
        unsubscribeControl?.();
        unsubscribeControl = pi.events?.on(BACKGROUND_WORKFLOW_CONTROL_CHANNEL, (payload) => {
            if (generation !== lifecycleGeneration) return;
            const control = parseBackgroundWorkflowControl(payload, { ...route, instanceId });
            if (!control) return;
            void (async () => {
                try {
                    const result = await manager.control(control.runId, control.action, control.agentId);
                    if (generation !== lifecycleGeneration) return;
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
                    if (generation !== lifecycleGeneration) return;
                    pi.events?.emit(BACKGROUND_WORKFLOW_CONTROL_RESULT_CHANNEL, {
                        schema: "pi.workflow.background.control.result",
                        version: 1,
                        ...route,
                        instanceId,
                        requestId: control.requestId,
                        ok: false,
                        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
                    });
                }
            })();
        });
        let recovered: Awaited<ReturnType<WorkflowRunManager["initialize"]>> | undefined;
        const initialize = initializationQueue.then(async () => {
            if (generation !== lifecycleGeneration || abort.signal.aborted) return;
            recovered = await manager.initialize(route.cwd);
        });
        initializationQueue = initialize.catch(() => {});
        await initialize;
        if (generation !== lifecycleGeneration || abort.signal.aborted || !recovered) return;
        emitEnvelope("ready", {}, route);
        for (const run of recovered.filter(
            (item) => !["succeeded", "failed", "cancelled", "timed_out"].includes(item.status),
        )) {
            if (generation !== lifecycleGeneration || abort.signal.aborted) return;
            try {
                const choice = await ctx.ui.select(
                    `Interrupted workflow: ${run.name}`,
                    ["Resume", "Inspect", "Stop", "Later"],
                    { signal: abort.signal },
                );
                if (generation !== lifecycleGeneration || abort.signal.aborted) return;
                if (choice === "Resume") await backend.recover?.(run.id);
                else if (choice === "Inspect") ctx.ui.notify(JSON.stringify(backend.inspect(run.id).run), "info");
                else if (choice === "Stop") await backend.control(run.id, "stop");
            } catch (error) {
                if (generation !== lifecycleGeneration || abort.signal.aborted) return;
                ctx.ui.notify(
                    `Could not recover workflow ${run.name}: ${error instanceof Error ? error.message : String(error)}`,
                    "warning",
                );
            }
        }
        if (generation !== lifecycleGeneration || abort.signal.aborted) return;
        for (const run of manager.list())
            if (run.sessionId === route.sessionId && run.cwd === route.cwd) emitEnvelope("upsert", { run }, route);
    });
    pi.on("session_shutdown", async () => {
        const generation = ++lifecycleGeneration;
        recoveryAbort?.abort();
        recoveryAbort = undefined;
        unsubscribeControl?.();
        unsubscribeControl = undefined;
        const route = { sessionId, cwd };
        const shutdown = initializationQueue.then(() => manager.shutdown());
        initializationQueue = shutdown.catch(() => {});
        await shutdown;
        if (generation === lifecycleGeneration) emitEnvelope("reset", {}, route);
    });
    const authorize = async (key: string, title: string, body: string, ui: Partial<ExtensionUIContext>) => {
        if (await approvalStore.has(key)) return;
        if (!ui.confirm || !(await ui.confirm(title, body))) throw new Error("Workflow launch was denied.");
        // Confirmation-only hosts can authorize this run but cannot express durable trust.
        if (!ui.select) return;
        const choice = await ui.select(title, ["Run once", "Trust unchanged script in this project"]);
        if (choice === undefined) throw new Error("Workflow launch was denied.");
        if (choice === "Trust unchanged script in this project") await approvalStore.add(key);
    };
    const launchFile = async (requestedPath: string, args: unknown, ctx: ExtensionContext) => {
        const canonical = await fs.promises.realpath(ctx.cwd);
        const source = await readWorkflowFile(canonical, requestedPath);
        const repositoryRoot = await findRepositoryRoot(canonical);
        const project = repositoryRoot ?? canonical;
        const relative = path.relative(project, source.path);
        const insideProject = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        if (repositoryRoot && insideProject && !ctx.isProjectTrusted?.())
            throw new Error(`Project workflow "${source.name}" is not trusted. Trust the project before running it.`);
        const preview = preflightWorkflow(source.script);
        await authorize(
            workflowApprovalKey(project, source.path, source.script),
            `Approve workflow file: ${source.name}`,
            `Source: ${source.path}\nPhases: ${preview.phases.join(", ") || "dynamic"}\nVisible agent calls: ${preview.agents}\n\n${source.script}`,
            ctx.ui,
        );
        return manager.launch({ name: source.name, script: source.script, args, sessionId, cwd: canonical });
    };
    pi.registerCommand("workflow", {
        description: "Run a workflow file",
        handler: async (text: string, ctx: ExtensionCommandContext) => {
            const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
            if (!match?.[1]) {
                ctx.ui.notify("Usage: /workflow <path> [JSON args]", "warning");
                return;
            }
            let args: unknown;
            if (match[2]) {
                try {
                    args = JSON.parse(match[2]);
                } catch {
                    throw new Error("Workflow arguments must be valid JSON.");
                }
            }
            const launched = await launchFile(match[1], args, ctx);
            ctx.ui.notify(`Started workflow ${launched.runId}.`, "info");
        },
    });
    pi.registerTool({
        name: "workflow",
        label: "Workflow",
        description:
            "Approve and launch either an inline script or an explicit workflow file path with structured arguments (exactly one).",
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
            const canonical = await fs.promises.realpath(ctx.cwd);
            const project = (await findRepositoryRoot(canonical)) ?? canonical;
            let inlineName = "Inline workflow";
            if (/\bexport\s+const\s+meta\s*=/.test(script))
                inlineName = parseWorkflowMetadata(script, "inline workflow").name;
            await authorize(
                workflowApprovalKey(project, inlineName, script),
                "Run inline workflow",
                `Phases: ${preview.phases.join(", ") || "dynamic"}\nVisible agent calls: ${preview.agents}\n\n${script}`,
                ui,
            );
            const launched = await manager.launch({
                name: inlineName,
                script,
                args: params.args,
                sessionId,
                cwd: canonical,
            });
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
