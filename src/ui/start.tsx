import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { App } from "./components/app.js";
import { syntaxStyle, theme } from "./components/theme.js";
import { type ControllerOptions, PuiController } from "./state/controller.js";

export interface UiStartOptions extends ControllerOptions {
    initialPrompt?: string;
}

/** The UI's single entry point: creates the controller and renderer, mounts the
 * Solid shell, and resolves once the TUI has been torn down. */
export async function startUi(options: UiStartOptions): Promise<void> {
    const controller = await PuiController.create(options);
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 60,
        useKittyKeyboard: {},
        useMouse: true,
        autoFocus: true,
        openConsoleOnError: false,
        backgroundColor: theme.background,
    });

    const destroyed = new Promise<void>((resolve) => renderer.once("destroy", resolve));
    const destroy = () => {
        if (!renderer.isDestroyed) renderer.destroy();
    };
    // The renderer owns Ctrl+C in raw mode; these arrive from outside (kill, a closing terminal).
    process.once("SIGTERM", destroy);
    process.once("SIGHUP", destroy);
    process.once("SIGINT", destroy);

    try {
        await render(() => <App controller={controller} initialPrompt={options.initialPrompt} />, renderer);
        await destroyed;
    } finally {
        process.off("SIGTERM", destroy);
        process.off("SIGHUP", destroy);
        process.off("SIGINT", destroy);
        destroy();
        await controller.dispose();
        syntaxStyle.destroy();
    }
}
