#!/usr/bin/env bun

import * as path from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { errorMessage } from "../extensions/shared/validate.js";
import { App } from "./app.js";
import { type ControllerOptions, PuiController } from "./controller.js";
import { parseHeadlessWorkflowArgs, runHeadlessWorkflow } from "./headless-workflow.js";
import { syntaxStyle, theme } from "./theme.js";
import { runCompiledWorkflowSmoke } from "./workflow-smoke.js";

// pi-ai's OAuth implementations use bundler-opaque imports in source mode.
// Register their static equivalents so Bun embeds them in the executable.
registerBunOAuthFlows();

interface CliOptions extends ControllerOptions {
    initialPrompt?: string;
    help?: boolean;
}

function usage(): string {
    return `pui

Usage:
  pui [options] [prompt]
  pui workflow [--cwd <path>] <file.ts> [JSON args]

Options:
  -c, --continue       Continue the most recent session
  --session <path>     Open a Pi JSONL session
  --no-session         Do not persist this session
  --cwd <path>         Set the working directory
  -h, --help           Show this help

Inside the TUI, press Ctrl+K for commands and /help for hotkeys.`;
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = { cwd: process.cwd() };
    const prompt: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? "";
        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }
        if (arg === "-c" || arg === "--continue") {
            options.continueRecent = true;
            continue;
        }
        if (arg === "--no-session") {
            options.noSession = true;
            continue;
        }
        if (arg === "--session") {
            const value = argv[++index];
            if (!value) throw new Error("--session requires a path");
            options.sessionPath = path.resolve(value);
            continue;
        }
        if (arg === "--cwd") {
            const value = argv[++index];
            if (!value) throw new Error("--cwd requires a path");
            options.cwd = path.resolve(value);
            continue;
        }
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        prompt.push(arg);
    }

    if (prompt.length > 0) options.initialPrompt = prompt.join(" ");
    return options;
}

async function main(): Promise<void> {
    if (process.argv[2] === "workflow") {
        const result = await runHeadlessWorkflow({
            ...parseHeadlessWorkflowArgs(process.argv.slice(3)),
            onProgress: (message) => process.stderr.write(`pui workflow: ${message}\n`),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (process.argv[2] === "--workflow-smoke") {
        await runCompiledWorkflowSmoke();
        return;
    }
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
        throw new Error("pui requires an interactive terminal");
    }

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
    process.once("SIGTERM", destroy);
    process.once("SIGHUP", destroy);

    let initialPromptTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await render(() => <App controller={controller} />, renderer);
        if (options.initialPrompt) {
            const initialPrompt = options.initialPrompt;
            initialPromptTimer = setTimeout(() => {
                if (!renderer.isDestroyed) controller.handlePrompt(initialPrompt);
            }, 0);
        }
        await destroyed;
    } finally {
        if (initialPromptTimer) clearTimeout(initialPromptTimer);
        process.off("SIGTERM", destroy);
        process.off("SIGHUP", destroy);
        destroy();
        await controller.dispose();
        syntaxStyle.destroy();
    }
}

main().catch((error: unknown) => {
    process.stderr.write(`pui: ${errorMessage(error)}\n`);
    process.exitCode = 1;
});
