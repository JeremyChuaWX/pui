import { isTerminalSubagentStatus } from "#modules/subagents/interfaces/ui.js";
import { commandPaletteEntries, type PaletteCommandId, type PuiController } from "../state/controller.js";
import type { PuiSnapshot } from "../state/types.js";
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

    /** Palette-row actions keyed by descriptor id; the rows themselves come from the controller's command list. */
    const paletteActions: Record<PaletteCommandId, () => void> = {
        models: () => void openModels(),
        sessions: () => void openSessions(),
        subagents: openSubagents,
        "new-session": () => void controller.newSession(),
        compact: () => void controller.compact(),
        thinking: () => controller.cycleThinking(),
        "tool-details": () => host.toggleToolDetails(),
        "external-editor": () => host.openExternalEditor(),
        help: () => host.openDialog({ kind: "help" }),
        quit: () => controller.requestExit(),
    };

    function openCommands(): void {
        host.closeCompletions();
        host.openDialog({
            kind: "picker",
            title: "Commands",
            placeholder: "Search commands",
            items: commandPaletteEntries().map(
                (entry): PickerItem => ({
                    label: entry.label,
                    detail: entry.detail,
                    search: `${entry.label} ${entry.detail}`.toLowerCase(),
                    action: () => {
                        host.closeDialog();
                        paletteActions[entry.id]();
                    },
                }),
            ),
        });
    }

    return { openModels, openSessions, openSubagents, openCommands };
}
