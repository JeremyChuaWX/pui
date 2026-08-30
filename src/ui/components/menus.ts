import { commandPaletteEntries, type PaletteCommandId, type PuiController } from "../state/controller.js";
import type { DialogState, PickerItem } from "./dialogs.js";

/** The controller surface the menus depend on; a fake satisfies it in tests. */
export type MenuController = Pick<
    PuiController,
    | "listModels"
    | "selectModel"
    | "listSessions"
    | "switchSession"
    | "newSession"
    | "compact"
    | "cycleThinking"
    | "requestExit"
>;

export interface MenuHost {
    controller: MenuController;
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

    /** Palette-row actions keyed by descriptor id; the rows themselves come from the controller's command list. */
    const paletteActions: Record<PaletteCommandId, () => void> = {
        models: () => void openModels(),
        sessions: () => void openSessions(),
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

    return { openModels, openSessions, openCommands };
}
