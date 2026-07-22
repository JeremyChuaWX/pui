import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    type AgentSessionRuntime,
    createAgentSessionRuntime,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUNDLED_EXTENSION_FACTORIES, BUNDLED_SUBAGENT_SOURCE_PATH } from "./bundled-extensions.js";
import { createPuiRuntime } from "./controller.js";

const bundledTools = {
    "<inline:pui-subagent>": ["subagent"],
    "<inline:pui-web>": ["web_crawl", "web_search"],
} as const;

function expectOneOfEachBundledTool(runtime: AgentSessionRuntime, cwd: string): void {
    expect(runtime.cwd).toBe(cwd);
    const extensions = runtime.services.resourceLoader.getExtensions();
    expect(extensions.errors).toEqual([]);
    for (const [resolvedPath, toolNames] of Object.entries(bundledTools)) {
        expect(extensions.extensions.filter((extension) => extension.resolvedPath === resolvedPath)).toHaveLength(1);
        for (const name of toolNames) {
            expect(runtime.session.getAllTools().filter((tool) => tool.name === name)).toHaveLength(1);
        }
    }
}

describe("bundled extensions", () => {
    test("exposes application-owned tools as named inline factories with the subagent source intact", async () => {
        expect(BUNDLED_EXTENSION_FACTORIES.map(({ name }) => name)).toEqual(["pui-subagent", "pui-web"]);
        expect(path.isAbsolute(BUNDLED_SUBAGENT_SOURCE_PATH)).toBe(true);
        expect((await fs.promises.stat(BUNDLED_SUBAGENT_SOURCE_PATH)).isFile()).toBe(true);
    });

    test("the controller runtime factory preserves one of each bundled tool across session replacement", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-runtime-replacement-test-"));
        const initialCwd = path.join(temp, "initial-cwd");
        const resumedCwd = path.join(temp, "resumed-cwd");
        const agentDir = path.join(temp, "agent-dir");
        const sessionDir = path.join(temp, "sessions");
        await Promise.all([
            fs.promises.mkdir(initialCwd, { recursive: true }),
            fs.promises.mkdir(resumedCwd, { recursive: true }),
            fs.promises.mkdir(agentDir, { recursive: true }),
            fs.promises.mkdir(sessionDir, { recursive: true }),
        ]);

        const runtime = await createAgentSessionRuntime(createPuiRuntime, {
            cwd: initialCwd,
            agentDir,
            sessionManager: SessionManager.inMemory(initialCwd),
        });
        try {
            expectOneOfEachBundledTool(runtime, initialCwd);

            expect((await runtime.newSession()).cancelled).toBe(false);
            expectOneOfEachBundledTool(runtime, initialCwd);

            const forkEntryId = runtime.session.sessionManager.appendMessage({
                role: "user",
                content: [{ type: "text", text: "Fork this in-memory session fixture." }],
                timestamp: Date.now(),
            });
            expect((await runtime.fork(forkEntryId)).cancelled).toBe(false);
            expectOneOfEachBundledTool(runtime, initialCwd);

            const resumedManager = SessionManager.create(resumedCwd, sessionDir);
            resumedManager.appendMessage({
                role: "user",
                content: [{ type: "text", text: "Persist a cwd-changing session fixture." }],
                timestamp: Date.now(),
            });
            resumedManager.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "Fixture persisted." }],
                api: "fixture-api",
                provider: "fixture-provider",
                model: "fixture-model",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            });
            const resumedPath = resumedManager.getSessionFile();
            if (!resumedPath) throw new Error("Expected a persisted session fixture");

            expect((await runtime.switchSession(resumedPath)).cancelled).toBe(false);
            expectOneOfEachBundledTool(runtime, resumedCwd);
        } finally {
            await runtime.dispose();
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });

    test("loads and reloads bundled extensions without disabling normal discovery", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-bundled-loader-test-"));
        const cwd = path.join(temp, "session-cwd");
        const agentDir = path.join(temp, "agent-dir");
        const globalExtensionDir = path.join(agentDir, "extensions");
        const projectExtensionDir = path.join(cwd, ".pi", "extensions");
        await Promise.all([
            fs.promises.mkdir(globalExtensionDir, { recursive: true }),
            fs.promises.mkdir(projectExtensionDir, { recursive: true }),
        ]);
        await Promise.all([
            fs.promises.writeFile(
                path.join(globalExtensionDir, "global-fixture.ts"),
                'export default function (pi: any) { pi.registerCommand("global-fixture", { handler() {} }); }\n',
            ),
            fs.promises.writeFile(
                path.join(projectExtensionDir, "project-fixture.ts"),
                'export default function (pi: any) { pi.registerCommand("project-fixture", { handler() {} }); }\n',
            ),
        ]);

        try {
            const settingsManager = SettingsManager.inMemory();
            settingsManager.setProjectTrusted(true);
            const loader = new DefaultResourceLoader({
                cwd,
                agentDir,
                settingsManager,
                extensionFactories: BUNDLED_EXTENSION_FACTORIES,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
            });

            for (let load = 0; load < 2; load += 1) {
                await loader.reload();
                const result = loader.getExtensions();
                expect(result.errors).toEqual([]);
                const bundledToolNames: string[] = [];
                for (const [resolvedPath, expectedToolNames] of Object.entries(bundledTools)) {
                    const bundled = result.extensions.filter((extension) => extension.resolvedPath === resolvedPath);
                    expect(bundled).toHaveLength(1);
                    const names = [...bundled[0]!.tools.keys()].sort();
                    expect(names).toEqual([...expectedToolNames].sort());
                    bundledToolNames.push(...names);
                }
                expect(new Set(bundledToolNames).size).toBe(bundledToolNames.length);

                const commandNames = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
                expect(commandNames).toContain("global-fixture");
                expect(commandNames).toContain("project-fixture");
            }

            const extensionDir = path.dirname(BUNDLED_SUBAGENT_SOURCE_PATH);
            for (const relativePath of [
                "protocol.ts",
                "runner.ts",
                path.join("agents", "worker.md"),
                path.join("agents", "worker-guidance.LICENSE"),
                path.join("agents", "explore.md"),
            ]) {
                expect((await fs.promises.stat(path.join(extensionDir, relativePath))).isFile()).toBe(true);
            }
        } finally {
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });
});
