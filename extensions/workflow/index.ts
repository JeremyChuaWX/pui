import * as fs from "node:fs";
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
    BACKGROUND_WORKFLOW_SAVE_CHANNEL,
    BACKGROUND_WORKFLOW_SAVE_RESULT_CHANNEL,
    BACKGROUND_WORKFLOW_SCHEMA,
    BACKGROUND_WORKFLOW_VERSION,
    parseBackgroundWorkflowControl,
    parseBackgroundWorkflowSave,
} from "./background-protocol.js";
import { WorkflowRunManager } from "./manager.js";
import { WorkflowRunStorage } from "./run-storage.js";
import {
    discoverWorkflows,
    findRepositoryRoot,
    parseWorkflowMetadata,
    saveWorkflow,
    type WorkflowStorageOptions,
} from "./storage.js";

const WorkflowParams = Type.Object({
    script: Type.Optional(
        Type.String({ description: "Exact inline JavaScript orchestration script to approve and run." }),
    ),
    name: Type.Optional(
        Type.String({ description: "Saved workflow name. Exactly one of script or name is required." }),
    ),
    args: Type.Optional(Type.Unknown()),
});
export interface WorkflowExtensionDependencies {
    backend?: WorkflowBackend;
    backendOptions?: Omit<WorkflowBackendOptions, "eventSink">;
    environment?: NodeJS.ProcessEnv;
    instanceId?: string;
    storageOptions?: WorkflowStorageOptions;
    approvalStore?: WorkflowApprovalStore;
}

export function registerWorkflowExtension(pi: ExtensionAPI, dependencies: WorkflowExtensionDependencies = {}): void {
    const environment = dependencies.environment ?? process.env;
    if (environment.PUI_WORKFLOWS !== "1") return;
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
        unsubscribeSave: (() => void) | undefined,
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
        unsubscribeSave?.();
        unsubscribeSave = pi.events?.on(BACKGROUND_WORKFLOW_SAVE_CHANNEL, (payload) => {
            if (generation !== lifecycleGeneration) return;
            const value = parseBackgroundWorkflowSave(payload, { ...route, instanceId });
            if (!value) return;
            void (async () => {
                try {
                    const inspected = manager.inspect(value.runId);
                    const metadata = parseWorkflowMetadata(inspected.script, "inspected workflow");
                    const savedPath = await saveWorkflow(
                        {
                            cwd: route.cwd,
                            name: metadata.name,
                            script: inspected.script,
                            scope: value.scope,
                            overwrite: value.overwrite,
                        },
                        dependencies.storageOptions,
                    );
                    if (generation !== lifecycleGeneration) return;
                    pi.events?.emit(BACKGROUND_WORKFLOW_SAVE_RESULT_CHANNEL, {
                        schema: "pi.workflow.background.save.result",
                        version: 1,
                        ...route,
                        instanceId,
                        requestId: value.requestId,
                        ok: true,
                        path: savedPath,
                    });
                } catch (error) {
                    if (generation !== lifecycleGeneration) return;
                    pi.events?.emit(BACKGROUND_WORKFLOW_SAVE_RESULT_CHANNEL, {
                        schema: "pi.workflow.background.save.result",
                        version: 1,
                        ...route,
                        instanceId,
                        requestId: value.requestId,
                        ok: false,
                        ...((error as { code?: unknown })?.code === "overwrite_required"
                            ? { code: "overwrite_required" as const }
                            : {}),
                        error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
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
        unsubscribeSave?.();
        unsubscribeSave = undefined;
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
    const launchSaved = async (name: string, args: unknown, ctx: ExtensionContext) => {
        const canonical = await fs.promises.realpath(ctx.cwd);
        const saved = (await discoverWorkflows(canonical, dependencies.storageOptions)).find(
            (item) => item.name === name,
        );
        if (!saved) throw new Error(`Unknown saved workflow "${name}". Use /workflow completion to list definitions.`);
        if (saved.scope === "project" && !ctx.isProjectTrusted?.())
            throw new Error(`Project workflow "${name}" is not trusted. Trust the project before running it.`);
        const project = saved.projectRoot ?? (await findRepositoryRoot(canonical)) ?? canonical;
        const key = workflowApprovalKey(project, saved.name, saved.script);
        const preview = preflightWorkflow(saved.script);
        await authorize(
            key,
            `Approve saved workflow: ${saved.name}`,
            `Source: ${saved.path}\nPhases: ${preview.phases.join(", ") || "dynamic"}\nVisible agent calls: ${preview.agents}\n\n${saved.script}`,
            ctx.ui,
        );
        return manager.launch({ name: saved.name, script: saved.script, args, sessionId, cwd: canonical });
    };
    pi.registerCommand("workflow", {
        description: "Run a saved workflow without regenerating its script",
        getArgumentCompletions: async (prefix: string) =>
            (await discoverWorkflows(cwd || process.cwd(), dependencies.storageOptions))
                .filter((item) => item.name.startsWith(prefix.trim().split(/\s+/, 1)[0] ?? ""))
                .map((item) => ({ value: item.name, label: item.name, description: item.description })),
        handler: async (text: string, ctx: ExtensionCommandContext) => {
            const [name, ...rest] = text.trim().split(/\s+/);
            if (!name) {
                ctx.ui.notify("Usage: /workflow <name> [JSON args]", "warning");
                return;
            }
            let args: unknown;
            const raw = rest.join(" ");
            if (raw) {
                try {
                    args = JSON.parse(raw);
                } catch {
                    throw new Error("Workflow arguments must be valid JSON.");
                }
            }
            const launched = await launchSaved(name, args, ctx);
            ctx.ui.notify(`Started workflow ${launched.runId}.`, "info");
        },
    });
    pi.registerTool({
        name: "workflow",
        label: "Workflow",
        description:
            "Approve and launch either an inline script or a saved workflow name with structured arguments (exactly one).",
        parameters: WorkflowParams,
        async execute(_id, params, _signal, _update, ctx) {
            if (Boolean(params.script) === Boolean(params.name))
                throw new Error("Provide exactly one of script or saved workflow name.");
            if (params.name) {
                const launched = await launchSaved(params.name, params.args, ctx);
                return {
                    content: [{ type: "text", text: `Started saved workflow ${params.name} (${launched.runId}).` }],
                    details: { schema: "pi.workflow.launch", version: 1, runId: launched.runId },
                };
            }
            const script = params.script;
            if (!script) throw new Error("Provide exactly one of script or saved workflow name.");
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
