import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    createWorkflowBackend,
    preflightWorkflow,
    type WorkflowBackend,
    type WorkflowBackendOptions,
} from "./backend.js";
import {
    BACKGROUND_WORKFLOW_CHANNEL,
    BACKGROUND_WORKFLOW_CONTROL_CHANNEL,
    BACKGROUND_WORKFLOW_SCHEMA,
    BACKGROUND_WORKFLOW_VERSION,
    parseBackgroundWorkflowControl,
} from "./background-protocol.js";
import { WorkflowRunManager } from "./manager.js";

const WorkflowParams = Type.Object({
    script: Type.Optional(
        Type.String({ description: "Exact inline JavaScript orchestration script to approve and run." }),
    ),
    name: Type.Optional(
        Type.String({ description: "Display name for an inline workflow; saved-name execution is reserved for WS5." }),
    ),
    args: Type.Optional(Type.Unknown()),
});
export interface WorkflowExtensionDependencies {
    backend?: WorkflowBackend;
    backendOptions?: Omit<WorkflowBackendOptions, "eventSink">;
    environment?: NodeJS.ProcessEnv;
    instanceId?: string;
}

export function registerWorkflowExtension(pi: ExtensionAPI, dependencies: WorkflowExtensionDependencies = {}): void {
    const environment = dependencies.environment ?? process.env;
    if (environment.PUI_WORKFLOWS !== "1") return;
    const instanceId = dependencies.instanceId ?? crypto.randomUUID();
    const backend =
        dependencies.backend ??
        createWorkflowBackend(
            dependencies.backendOptions ?? {
                agentExecutor: async () => {
                    throw new Error("No workflow AgentExecutor is configured by this host.");
                },
            },
        );
    let sessionId = "unbound",
        cwd = "",
        unsubscribeControl: (() => void) | undefined,
        manager: WorkflowRunManager;
    const emitEnvelope = (type: "ready" | "reset" | "upsert" | "remove", extra: object = {}) =>
        pi.events?.emit(BACKGROUND_WORKFLOW_CHANNEL, {
            schema: BACKGROUND_WORKFLOW_SCHEMA,
            version: BACKGROUND_WORKFLOW_VERSION,
            sessionId,
            instanceId,
            cwd,
            type,
            ...extra,
        });
    manager = new WorkflowRunManager({
        backend,
        emit: (run) => emitEnvelope("upsert", { run }),
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
        sessionId = ctx.sessionManager.getSessionId();
        cwd = await fs.promises.realpath(ctx.cwd);
        unsubscribeControl?.();
        unsubscribeControl = pi.events?.on(BACKGROUND_WORKFLOW_CONTROL_CHANNEL, (payload) => {
            const control = parseBackgroundWorkflowControl(payload, { sessionId, instanceId, cwd });
            if (control) void manager.control(control.runId, control.type).catch(() => {});
        });
        emitEnvelope("ready");
        for (const run of manager.list())
            if (run.sessionId === sessionId && run.cwd === cwd) emitEnvelope("upsert", { run });
    });
    pi.on("session_shutdown", async () => {
        unsubscribeControl?.();
        await manager.shutdown();
        emitEnvelope("reset");
    });
    pi.registerTool({
        name: "workflow",
        label: "Workflow",
        description:
            "Approve and launch a bounded background JavaScript orchestration workflow. Saved workflow names are reserved for a later release.",
        parameters: WorkflowParams,
        async execute(_id, params, _signal, _update, ctx) {
            if (!params.script)
                throw new Error(
                    params.name
                        ? "Saved workflows are reserved for WS5; provide an inline script."
                        : "An inline workflow script is required.",
                );
            const preview = preflightWorkflow(params.script);
            const ui = (ctx as any).ui;
            if (!ui?.confirm)
                throw new Error(
                    "This host has no tool confirmation surface; refusing to run an unapproved inline workflow.",
                );
            const approved = await ui.confirm(
                `Run workflow: ${params.name || "Inline workflow"}`,
                `Phases: ${preview.phases.join(", ") || "dynamic"}\nVisible agent calls: ${preview.agents}\n\n${params.script}`,
            );
            if (!approved) throw new Error("Workflow launch was denied.");
            const canonical = await fs.promises.realpath(ctx.cwd);
            const launched = await manager.launch({
                name: (params.name || "Inline workflow").slice(0, 512),
                script: params.script,
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
