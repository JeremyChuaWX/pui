#!/usr/bin/env bun

import * as path from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { errorMessage } from "#shared/lib/validate.js";
import type { UiStartOptions } from "#ui/start.js";

// pi-ai's OAuth implementations use bundler-opaque imports in source mode.
// Register their static equivalents so Bun embeds them in the executable.
registerBunOAuthFlows();

interface CliOptions extends UiStartOptions {
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
    // Each dispatch target is imported lazily so the interactive path never
    // evaluates the workflow execution modules, and the headless paths never
    // evaluate any UI code.
    if (process.argv[2] === "workflow") {
        const { runHeadlessWorkflowCli } = await import("./headless-workflow.js");
        await runHeadlessWorkflowCli(process.argv.slice(3));
        return;
    }
    if (process.argv[2] === "--workflow-smoke") {
        const { runCompiledWorkflowSmoke } = await import("./workflow-smoke.js");
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

    const { startUi } = await import("#ui/start.js");
    await startUi(options);
}

main().catch((error: unknown) => {
    process.stderr.write(`pui: ${errorMessage(error)}\n`);
    process.exitCode = 1;
});
