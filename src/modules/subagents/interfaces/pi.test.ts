import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionApiHarness } from "#test-support/extension-api.ts";
import { createTerminalSubagentRun, updateSubagentRun } from "../run-state.ts";
import { AbortableSemaphore } from "../semaphore.ts";
import { registerSubagentExtension } from "./pi.ts";

const extensionCwd = path.dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;

function successRun(output = "delegated answer") {
    return async (options: any) => {
        let details = updateSubagentRun(options.run, {
            status: "running",
            phase: "thinking",
            startedAt: options.run.startedAt ?? Date.now(),
        });
        options.onSnapshot?.(details);
        details = createTerminalSubagentRun(details, { status: "succeeded", outputPreview: output });
        options.onSnapshot?.(details);
        return { run: details, output, stderr: "", exitCode: 0, signal: null };
    };
}

/** An extension host whose fake child spawner records every runner invocation. */
function spawnHost(environment: NodeJS.ProcessEnv = {}) {
    const host = createExtensionApiHarness();
    const runs: any[] = [];
    registerSubagentExtension(host.api, {
        semaphore: new AbortableSemaphore(4),
        environment,
        invocation: (args) => ({ command: "fake-pi", args }),
        run: async (options) => {
            runs.push(options);
            return successRun()(options);
        },
    });
    return {
        host,
        runs,
        /** Spawn under a Profile, then wait for the Job so the recorded runner options are complete. */
        async spawnAndWait(profile: "explorer" | "worker", params: Record<string, unknown> = {}) {
            const spawned = await host
                .tool(profile)
                .execute(
                    `${profile}-call`,
                    { prompt: `Use ${profile}`, cwd: extensionCwd, ...params },
                    undefined,
                    undefined,
                    {
                        cwd: extensionCwd,
                    },
                );
            const waited = await host.tool("subagent_wait").execute("wait", { ids: [spawned.details.id] });
            return { spawned, waited, run: runs.at(-1) };
        },
    };
}

function argumentAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
}

describe("subagent extension integration", () => {
    test("registers the two Profile spawn tools, the Job tools, and the lifecycle handlers", () => {
        const { host } = spawnHost();
        expect([...host.tools.keys()]).toEqual([
            "explorer",
            "worker",
            "subagent_wait",
            "subagent_check",
            "subagent_cancel",
        ]);
        expect(host.handlers.has("session_start")).toBe(true);
        expect(host.handlers.has("agent_settled")).toBe(true);
        expect(host.handlers.has("tool_result")).toBe(false);
        expect(host.handlers.has("session_shutdown")).toBe(true);
    });

    test("explorer returns a Job id immediately and runs a read-only child with its own system prompt", async () => {
        const fixture = spawnHost();
        const { spawned, waited, run } = await fixture.spawnAndWait("explorer", { prompt: "Inspect the target" });

        expect(spawned.details.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(spawned.details.run.status).toBe("queued");
        expect(spawned.details.run.agent).toBe("explorer");
        expect(spawned.details.run.model).toBe("openrouter/z-ai/glm-5.3-flash:low");
        expect(spawned.content[0].text).toContain(spawned.details.id);
        expect(waited.details.results[0].status).toBe("succeeded");

        expect(run.command).toBe("fake-pi");
        expect(run.cwd).toBe(extensionCwd);
        expect(argumentAfter(run.args, "--mode")).toBe("json");
        for (const flag of [
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
        ]) {
            expect(run.args).toContain(flag);
        }
        expect(argumentAfter(run.args, "--tools")).toBe("read,grep,find,ls");
        expect(argumentAfter(run.args, "--model")).toBe("openrouter/z-ai/glm-5.3-flash:low");
        expect(argumentAfter(run.args, "--system-prompt")).toContain("read-only codebase exploration subagent");
        expect(run.args).not.toContain("--append-system-prompt");
        expect(run.args.at(-1)).toBe("Inspect the target");
        expect(run.timeoutMs).toBe(60 * MINUTE);
    });

    test("worker runs a write-capable child with the Ponytail guidance appended", async () => {
        const fixture = spawnHost();
        const { spawned, run } = await fixture.spawnAndWait("worker", { prompt: "Implement the target" });

        expect(spawned.details.run.agent).toBe("worker");
        expect(spawned.details.run.model).toBe("openrouter/z-ai/glm-5.3-flash:high");
        expect(argumentAfter(run.args, "--tools")).toBe("read,bash,edit,write,grep,find,ls");
        expect(argumentAfter(run.args, "--model")).toBe("openrouter/z-ai/glm-5.3-flash:high");
        const guidance = argumentAfter(run.args, "--append-system-prompt") ?? "";
        expect(guidance).toContain("Lazy means efficient, not careless.");
        expect(guidance).toContain("Bug fix = root cause, not symptom");
        expect(guidance.toLowerCase()).not.toContain("ponytail");
        expect(run.args).not.toContain("--system-prompt");
        expect(run.args.at(-1)).toBe("Implement the target");
        expect(run.timeoutMs).toBe(60 * MINUTE);
    });

    test("resolves each Profile's model from the argument, then its environment variable, then the default", async () => {
        const fixture = spawnHost({
            PI_EXPLORER_MODEL: "fixture/explorer-env",
            PI_WORKER_MODEL: "fixture/worker-env",
        });

        const explorerEnv = await fixture.spawnAndWait("explorer");
        const explorerExplicit = await fixture.spawnAndWait("explorer", { model: "fixture/explorer-explicit" });
        const workerEnv = await fixture.spawnAndWait("worker");
        const workerExplicit = await fixture.spawnAndWait("worker", { model: " fixture/worker-explicit " });

        expect(argumentAfter(explorerEnv.run.args, "--model")).toBe("fixture/explorer-env");
        expect(argumentAfter(explorerExplicit.run.args, "--model")).toBe("fixture/explorer-explicit");
        expect(argumentAfter(workerEnv.run.args, "--model")).toBe("fixture/worker-env");
        expect(argumentAfter(workerExplicit.run.args, "--model")).toBe("fixture/worker-explicit");
        expect(workerExplicit.spawned.details.run.model).toBe("fixture/worker-explicit");

        const blank = spawnHost({ PI_WORKER_MODEL: "   " });
        const fallback = await blank.spawnAndWait("worker", { model: "" });
        expect(argumentAfter(fallback.run.args, "--model")).toBe("openrouter/z-ai/glm-5.3-flash:high");
    });

    test("tool descriptions state each Profile's tools, default model, and Limits", () => {
        const { host } = spawnHost();
        const explorer = host.tool("explorer");
        const worker = host.tool("worker");

        expect(explorer.description).toContain("read, grep, find, ls");
        expect(explorer.description).toContain("openrouter/z-ai/glm-5.3-flash:low");
        expect(explorer.description).toContain("PI_EXPLORER_MODEL");
        expect(worker.description).toContain("read, bash, edit, write, grep, find, ls");
        expect(worker.description).toContain("openrouter/z-ai/glm-5.3-flash:high");
        expect(worker.description).toContain("PI_WORKER_MODEL");
        for (const tool of [explorer, worker]) {
            expect(tool.description).toContain("60 minutes");
            expect(tool.description).toContain("10 minutes");
            expect(tool.description).toContain("15 minutes");
            expect(tool.parameters.required).toEqual(["prompt", "cwd"]);
            expect(Object.keys(tool.parameters.properties)).toEqual(["prompt", "cwd", "model", "name"]);
        }
    });

    test("normalises a relative cwd, a home-relative cwd, and a stray leading @", async () => {
        const fixture = spawnHost();
        const relative = path.relative(process.cwd(), extensionCwd);

        const fromRelative = await fixture.spawnAndWait("explorer", { cwd: `@../${path.basename(extensionCwd)}` });
        expect(fromRelative.run.cwd).toBe(extensionCwd);
        expect(fromRelative.spawned.details.run.cwd).toBe(extensionCwd);

        const fromParent = await fixture.host
            .tool("explorer")
            .execute("parent-relative", { prompt: "x", cwd: relative }, undefined, undefined, { cwd: process.cwd() });
        expect(fromParent.details.run.cwd).toBe(extensionCwd);

        const fromHome = await fixture.host
            .tool("worker")
            .execute("home", { prompt: "x", cwd: "~" }, undefined, undefined, { cwd: extensionCwd });
        expect(fromHome.details.run.cwd).toBe(fs.realpathSync(os.homedir()));
    });
});
