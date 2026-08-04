import type { WorkflowRunSummaryV1 } from "../../extensions/workflow/protocol.js";
import type { PuiController } from "../controller.js";
import { formatCount, formatWorkflowSummary, workflowStatusPresentation } from "../format.js";
import { isTerminalSubagentStatus } from "../subagent.js";
import type { PuiSnapshot } from "../types.js";
import type { DialogState, PickerItem } from "./dialogs.js";
import { compactSubagentUsage, subagentElapsed, subagentStatusIcon, subagentStatusLabel } from "./subagent-view.js";

/** The controller surface the menus depend on; a fake satisfies it in tests. */
export type MenuController = Pick<
    PuiController,
    | "listModels"
    | "selectModel"
    | "listSessions"
    | "switchSession"
    | "notify"
    | "snapshot"
    | "cancelBackgroundSubagent"
    | "inspectWorkflow"
    | "controlWorkflow"
    | "newSession"
    | "compact"
    | "cycleThinking"
    | "requestExit"
>;

export interface MenuHost {
    controller: MenuController;
    /** Latest UI snapshot (reactive store in the app, plain accessor in tests). */
    snapshot: () => PuiSnapshot;
    openDialog: (dialog: DialogState) => void;
    closeDialog: () => void;
    openAsyncPicker: (title: string, placeholder: string, load: () => Promise<PickerItem[]>) => Promise<void>;
    closeCompletions: () => void;
    toggleToolDetails: () => void;
    openExternalEditor: () => void;
}

/** Build every picker/palette in the app from the host seam, free of rendering concerns. */
export function createMenus(host: MenuHost) {
    const { controller } = host;

    function openModels(): Promise<void> {
        return host.openAsyncPicker("Select model", "Search provider or model", async () =>
            (await controller.listModels()).map((choice) => ({
                label: choice.label,
                detail: choice.detail,
                search: choice.search,
                action: () => void controller.selectModel(choice),
            })),
        );
    }

    function openSessions(): Promise<void> {
        return host.openAsyncPicker("Resume session", "Search session history", async () =>
            (await controller.listSessions()).map((choice) => ({
                label: choice.label,
                detail: choice.detail,
                search: choice.search,
                action: () => void controller.switchSession(choice.path),
            })),
        );
    }

    function openSubagents(): void {
        host.closeCompletions();
        const jobs = [...host.snapshot().backgroundSubagents].sort((a, b) => b.updatedAt - a.updatedAt);
        host.openDialog({
            kind: "picker",
            title: "Background subagents",
            placeholder: "Search title, model, or status",
            items: jobs.map((job) => {
                const active = !isTerminalSubagentStatus(job.status);
                const usage = compactSubagentUsage(job.usage);
                return {
                    label: `${subagentStatusIcon(job.status)} ${job.title}`,
                    detail: `${subagentStatusLabel(job.status)} · ${job.model}${usage ? ` · ${usage}` : ""}${active ? " · select to cancel" : ""}`,
                    search: `${job.title} ${job.model} ${job.agent} ${job.status}`.toLowerCase(),
                    action: () => {
                        host.closeDialog();
                        const current = host
                            .snapshot()
                            .backgroundSubagents.find((candidate) => candidate.id === job.id);
                        if (!current) return;
                        const notifyStatus = (job: (typeof jobs)[number]) =>
                            controller.notify(
                                `${job.title} · ${subagentStatusLabel(job.status)} · ${subagentElapsed(job)}`,
                                job.status === "succeeded" ? "success" : "info",
                            );
                        if (isTerminalSubagentStatus(current.status)) {
                            notifyStatus(current);
                        } else if (controller.cancelBackgroundSubagent(current.id)) {
                            controller.notify(`Cancelling ${current.title}`, "warning");
                        } else {
                            const settled = controller
                                .snapshot()
                                .backgroundSubagents.find((candidate) => candidate.id === job.id);
                            if (settled && isTerminalSubagentStatus(settled.status)) notifyStatus(settled);
                        }
                    },
                };
            }),
        });
    }

    function confirmDestructive(
        title: string,
        message: string,
        confirmLabel: string,
        action: () => Promise<string | undefined>,
        success = "Workflow control completed.",
    ): void {
        host.openDialog({
            kind: "confirm",
            title,
            message,
            confirmLabel,
            action: () => {
                host.closeDialog();
                void action().then(
                    (linked) => controller.notify(linked ? `${success} New run: ${linked}.` : success, "success"),
                    (error) => controller.notify(error instanceof Error ? error.message : String(error), "error"),
                );
            },
        });
    }

    function runControl(runId: string, action: "pause" | "resume", success: string): () => void {
        return () => {
            host.closeDialog();
            void controller.controlWorkflow(runId, action).then(
                () => controller.notify(success, "success"),
                (error) => controller.notify(error instanceof Error ? error.message : String(error), "error"),
            );
        };
    }

    function openWorkflowAgent(run: WorkflowRunSummaryV1, agentId: string): void {
        const agent = run.agents.find((item) => item.id === agentId);
        if (!agent) return;
        const status = workflowStatusPresentation(agent.status);
        host.openDialog({
            kind: "picker",
            title: `${status.icon} ${agent.label}`,
            placeholder: "Inspect or choose an action",
            items: [
                {
                    label: "Status",
                    detail: `${status.label} · ${agent.role}${agent.model ? ` · ${agent.model}` : ""}`,
                    search: "status",
                    action: () => {},
                },
                ...(agent.prompt
                    ? [{ label: "Prompt", detail: agent.prompt, search: `prompt ${agent.prompt}`, action: () => {} }]
                    : []),
                ...(agent.output
                    ? [{ label: "Output", detail: agent.output, search: `output ${agent.output}`, action: () => {} }]
                    : []),
                ...(agent.error
                    ? [{ label: "Error", detail: agent.error, search: `error ${agent.error}`, action: () => {} }]
                    : []),
                ...agent.recentActivity.map((activity) => ({
                    label: activity.isError ? "× Activity" : "· Activity",
                    detail: activity.title,
                    search: `activity ${activity.title}`,
                    action: () => {},
                })),
                {
                    label: "Restart agent",
                    detail: "Destructive: abort and rerun this operation",
                    search: "restart rerun",
                    action: () =>
                        confirmDestructive(
                            "Restart agent?",
                            `Abort and rerun ${agent.label}? Existing output may be replaced.`,
                            "Restart",
                            () => controller.controlWorkflow(run.id, "restart-agent", agent.id),
                        ),
                },
            ],
        });
    }

    function openWorkflowPhase(run: WorkflowRunSummaryV1, phaseId: string): void {
        const phase = run.phases.find((item) => item.id === phaseId);
        if (!phase) return;
        host.openDialog({
            kind: "picker",
            title: `Phase · ${phase.name}`,
            placeholder: "Search agents",
            items: phase.agentIds.map((id) => {
                const agent = run.agents.find((item) => item.id === id);
                return {
                    label: agent ? `${workflowStatusPresentation(agent.status).icon} ${agent.label}` : id,
                    detail: agent ? workflowStatusPresentation(agent.status).label : "Unavailable",
                    search: `${agent?.label ?? id} ${agent?.status ?? ""}`.toLowerCase(),
                    action: () => openWorkflowAgent(run, id),
                };
            }),
        });
    }

    function openWorkflowRun(runId: string): void {
        const run = controller.inspectWorkflow(runId);
        if (!run) {
            controller.notify("Workflow is no longer available.", "error");
            return;
        }
        const items: PickerItem[] = [
            {
                label: formatWorkflowSummary(run),
                detail: `${formatCount(run.usage.totalTokens)} tokens · $${run.usage.cost.toFixed(4)}`,
                search: `${run.name} ${run.status}`,
                action: () => {},
            },
            ...run.phases.map((phase) => ({
                label: `${workflowStatusPresentation(phase.status === "skipped" ? "cancelled" : phase.status).icon} ${phase.name}`,
                detail: `${phase.status} · ${phase.agentIds.length} agents`,
                search: `${phase.name} ${phase.status}`,
                action: () => openWorkflowPhase(run, phase.id),
            })),
            {
                label: "All agents",
                detail: `${run.agents.length} total · list rendering is windowed`,
                search: "agents",
                action: () =>
                    host.openDialog({
                        kind: "picker",
                        title: `${run.name} · agents`,
                        placeholder: "Search agents",
                        items: run.agents.map((agent) => ({
                            label: `${workflowStatusPresentation(agent.status).icon} ${agent.label}`,
                            detail: `${workflowStatusPresentation(agent.status).label} · ${agent.role}`,
                            search: `${agent.label} ${agent.role} ${agent.model ?? ""} ${agent.status}`.toLowerCase(),
                            action: () => openWorkflowAgent(run, agent.id),
                        })),
                    }),
            },
        ];
        if (run.status === "running" || run.status === "queued")
            items.push({
                label: "Pause",
                detail: "Allow active agents to finish; schedule no new work",
                search: "pause",
                action: runControl(run.id, "pause", "Workflow paused."),
            });
        if (run.status === "paused")
            items.push({
                label: "Resume",
                detail: "Continue scheduling",
                search: "resume",
                action: runControl(run.id, "resume", "Workflow resumed."),
            });
        if (["running", "queued", "paused"].includes(run.status))
            items.push({
                label: "Stop",
                detail: "Destructive: abort worker and active agents",
                search: "stop",
                action: () =>
                    confirmDestructive("Stop workflow?", `Stop ${run.name} and all active agents?`, "Stop", () =>
                        controller.controlWorkflow(run.id, "stop"),
                    ),
            });
        if (["failed", "cancelled", "succeeded"].includes(run.status))
            items.push({
                label: "Retry run",
                detail: "Destructive: create a replay run",
                search: "retry",
                action: () =>
                    confirmDestructive("Retry workflow?", `Create a new replay of ${run.name}?`, "Retry", () =>
                        controller.controlWorkflow(run.id, "retry"),
                    ),
            });
        items.push({
            label: "Open script/artifacts",
            detail: "Unavailable until WS5/WS6 detail and artifact APIs",
            search: "editor script artifact",
            action: () =>
                controller.notify("Script and artifact inspection requires the WS5/WS6 host APIs.", "warning"),
        });
        host.openDialog({
            kind: "picker",
            title: `Workflow · ${run.name}`,
            placeholder: "Inspect phases, agents, or controls",
            items,
        });
    }

    function openWorkflows(): void {
        host.closeCompletions();
        const runs = [...host.snapshot().workflows].sort((a, b) => b.updatedAt - a.updatedAt);
        host.openDialog({
            kind: "picker",
            title: "Workflows",
            placeholder: "Search name, phase, or status",
            items: runs.map((run) => ({
                label: formatWorkflowSummary(run),
                detail: `${formatCount(run.usage.totalTokens)} tokens`,
                search: `${run.name} ${run.status} ${run.currentPhase ?? ""}`.toLowerCase(),
                action: () => openWorkflowRun(run.id),
            })),
        });
    }

    function openCommands(): void {
        host.closeCompletions();
        const command = (label: string, detail: string, action: () => void): PickerItem => ({
            label,
            detail,
            search: `${label} ${detail}`.toLowerCase(),
            action: () => {
                host.closeDialog();
                action();
            },
        });
        host.openDialog({
            kind: "picker",
            title: "Commands",
            placeholder: "Search commands",
            items: [
                command("Models", "Switch the active model", () => void openModels()),
                command("Sessions", "Resume a previous session", () => void openSessions()),
                command("Subagents", "Inspect or cancel background jobs", openSubagents),
                command("Workflows", "Inspect and control workflow runs", openWorkflows),
                command("New session", "Start with a clean conversation", () => void controller.newSession()),
                command("Compact context", "Summarize older conversation history", () => void controller.compact()),
                command("Thinking level", "Cycle the current reasoning level", () => controller.cycleThinking()),
                command("Tool details", "Expand or collapse tool output", () => host.toggleToolDetails()),
                command("Edit in nvim", "Edit the prompt with the last agent response as reference", () =>
                    host.openExternalEditor(),
                ),
                command("Help", "Show keyboard shortcuts", () => host.openDialog({ kind: "help" })),
                command("Quit", "Exit pui", () => controller.requestExit()),
            ],
        });
    }

    return { openModels, openSessions, openSubagents, openWorkflows, openWorkflowRun, openCommands };
}

export type Menus = ReturnType<typeof createMenus>;
