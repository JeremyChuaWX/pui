import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    type AgentSessionRuntime,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { resolveFdBinary } from "../extensions/file-search/binaries.js";
import { BUNDLED_EXTENSION_FACTORIES, BUNDLED_SUBAGENT_SOURCE_PATH } from "./bundled-extensions.js";
import { createPuiRuntime } from "./controller.js";

const bundledTools = {
    "<inline:pui-file-search>": ["fd", "rg"],
    "<inline:pui-subagent>": [
        "subagent",
        "subagent_spawn",
        "subagent_wait",
        "subagent_check",
        "subagent_cancel",
        "subagent_list",
    ],
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
        expect(BUNDLED_EXTENSION_FACTORIES.map(({ name }) => name)).toEqual([
            "pui-file-search",
            "pui-subagent",
            "pui-web",
        ]);
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

    test.skipIf(process.platform === "win32")("shares the fdfind fallback with @ file completion", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-fdfind-autocomplete-test-"));
        const fdfind = path.join(temp, "fdfind");
        const match = path.join(temp, "needle.txt");
        await Promise.all([
            fs.promises.writeFile(match, "fixture\n"),
            fs.promises.writeFile(fdfind, `#!/bin/sh\nprintf '%s\\n' '${match}'\n`, { mode: 0o755 }),
        ]);

        try {
            const lookups: string[] = [];
            const binary = resolveFdBinary((name) => {
                lookups.push(name);
                return name === "fdfind" ? fdfind : undefined;
            });
            expect(lookups).toEqual(["fd", "fdfind"]);
            expect(binary.command).toBe(fdfind);

            const provider = new CombinedAutocompleteProvider([], temp, binary.command);
            const suggestions = await provider.getSuggestions(["@nee"], 0, 4, {
                signal: new AbortController().signal,
            });
            expect(suggestions?.prefix).toBe("@nee");
            expect(suggestions?.items.some((item) => item.value.includes("needle.txt"))).toBe(true);
        } finally {
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });

    test("normal Pi load order gives discovered extensions deterministic ownership of conflicting tools", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-bundled-conflict-test-"));
        const cwd = path.join(temp, "session-cwd");
        const agentDir = path.join(temp, "agent-dir");
        const globalExtensionDir = path.join(agentDir, "extensions");
        const projectExtensionDir = path.join(cwd, ".pi", "extensions");
        await Promise.all([
            fs.promises.mkdir(globalExtensionDir, { recursive: true }),
            fs.promises.mkdir(projectExtensionDir, { recursive: true }),
        ]);
        const fixture = (name: string, owner: string, unrelated: string) => `
import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({ name: "${name}", label: "${owner}", description: "owned by ${owner}", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "${owner}" }] }; } });
  pi.registerTool({ name: "${unrelated}", label: "${unrelated}", description: "unrelated", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "ok" }] }; } });
}
`;
        await Promise.all([
            fs.promises.writeFile(
                path.join(globalExtensionDir, "global-conflict.ts"),
                fixture("fd", "global", "global_extra"),
            ),
            fs.promises.writeFile(
                path.join(projectExtensionDir, "project-conflict.ts"),
                fixture("rg", "project", "project_extra"),
            ),
        ]);

        const settingsManager = SettingsManager.inMemory();
        settingsManager.setProjectTrusted(true);
        const runtime = await createAgentSessionRuntime(
            async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
                const services = await createAgentSessionServices({
                    cwd,
                    agentDir,
                    settingsManager,
                    resourceLoaderOptions: { extensionFactories: BUNDLED_EXTENSION_FACTORIES },
                });
                return {
                    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
                    services,
                    diagnostics: services.diagnostics,
                };
            },
            { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
        );
        try {
            const tools = runtime.session.getAllTools();
            for (const name of ["fd", "rg", "global_extra", "project_extra"]) {
                expect(tools.filter((tool) => tool.name === name)).toHaveLength(1);
            }
            const fd = tools.find((tool) => tool.name === "fd");
            const rg = tools.find((tool) => tool.name === "rg");
            expect(fd?.description).toBe("owned by global");
            expect(rg?.description).toBe("owned by project");
            const signal = new AbortController().signal;
            const fdDefinition = runtime.session.extensionRunner.getToolDefinition("fd");
            const rgDefinition = runtime.session.extensionRunner.getToolDefinition("rg");
            const fdResult = await fdDefinition?.execute("fd-fixture", {}, signal, undefined, { cwd } as never);
            const rgResult = await rgDefinition?.execute("rg-fixture", {}, signal, undefined, { cwd } as never);
            expect(fdResult?.content).toEqual([{ type: "text", text: "global" }]);
            expect(rgResult?.content).toEqual([{ type: "text", text: "project" }]);

            const extensions = runtime.services.resourceLoader.getExtensions();
            expect(extensions.errors.filter((error) => /fd.*conflict|conflict.*fd/i.test(error.error))).toHaveLength(1);
            expect(extensions.errors.filter((error) => /rg.*conflict|conflict.*rg/i.test(error.error))).toHaveLength(1);

            const fallback = resolveFdBinary((name) => (name === "fdfind" ? "/fixture/fdfind" : undefined));
            expect(fallback.command).toBe("/fixture/fdfind");
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
