import type { PuiController } from "./controller.js";
import { formatCount } from "./format.js";
import type { PromptAction } from "./types.js";

/**
 * The single source of truth for local slash commands: one entry drives
 * autocomplete, dispatch, and the command's behavior.
 */
export interface LocalCommand {
    name: string;
    description: string;
    argumentHint?: string;
    /** Dispatch-only aliases, hidden from autocomplete. */
    aliases?: readonly string[];
    /** Dispatchable but omitted from autocomplete (e.g. shadowed extension commands). */
    hidden?: boolean;
    run: (controller: PuiController, args: string) => PromptAction;
}

export const LOCAL_COMMANDS: readonly LocalCommand[] = [
    {
        name: "model",
        description: "Select the active model",
        argumentHint: "<provider/model>",
        aliases: ["models"],
        run: (controller, args) => {
            if (!args) return "models";
            void controller.selectModelBySpec(args);
            return "sent";
        },
    },
    { name: "resume", description: "Resume a previous session", aliases: ["sessions"], run: () => "sessions" },
    {
        name: "new",
        description: "Start a new session",
        aliases: ["clear"],
        run: (controller) => {
            void controller.newSession();
            return "sent";
        },
    },
    {
        name: "compact",
        description: "Compact conversation context",
        run: (controller, args) => {
            void controller.compact(args || undefined);
            return "sent";
        },
    },
    {
        name: "name",
        description: "Set the session name",
        argumentHint: "<name>",
        run: (controller, args) => {
            if (!args) controller.notify("Usage: /name <session name>", "warning");
            else controller.session.setSessionName(args);
            return "sent";
        },
    },
    {
        name: "reload",
        description: "Reload extensions, skills, prompts, and context",
        run: (controller) => {
            void controller.reload();
            return "sent";
        },
    },
    {
        name: "session",
        description: "Show session information",
        run: (controller) => {
            const session = controller.session;
            controller.notify(
                `${session.sessionName ?? session.sessionId.slice(0, 8)} · ${formatCount(session.getContextUsage()?.tokens)} context tokens`,
            );
            return "sent";
        },
    },
    { name: "commands", description: "Open the command palette", aliases: ["palette"], run: () => "commands" },
    { name: "subagents", description: "Inspect or cancel background subagents", run: () => "subagents" },
    { name: "workflows", description: "Inspect and control workflow runs", hidden: true, run: () => "workflows" },
    {
        name: "thinking",
        description: "Cycle the thinking level",
        run: (controller) => {
            controller.cycleThinking();
            return "sent";
        },
    },
    { name: "help", description: "Show keyboard shortcuts", run: () => "help" },
    { name: "hotkeys", description: "Show keyboard shortcuts", run: () => "help" },
    {
        name: "quit",
        description: "Quit",
        aliases: ["exit", "q"],
        run: (controller) => {
            controller.requestExit();
            return "sent";
        },
    },
];

export function findLocalCommand(name: string): LocalCommand | undefined {
    return LOCAL_COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}
