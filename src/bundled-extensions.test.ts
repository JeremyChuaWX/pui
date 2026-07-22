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
import {
  BUNDLED_EXTENSION_FACTORIES,
  BUNDLED_SUBAGENT_SOURCE_PATH,
} from "./bundled-extensions.js";
import { createPuiRuntime } from "./controller.js";

const bundledSubagentPath = "<inline:pui-subagent>";

function expectOneBundledSubagent(runtime: AgentSessionRuntime, cwd: string): void {
  expect(runtime.cwd).toBe(cwd);
  const extensions = runtime.services.resourceLoader.getExtensions();
  expect(extensions.errors).toEqual([]);
  expect(
    extensions.extensions.filter((extension) => extension.resolvedPath === bundledSubagentPath),
  ).toHaveLength(1);
  expect(runtime.session.getAllTools().filter((tool) => tool.name === "subagent")).toHaveLength(1);
}

describe("bundled extensions", () => {
  test("exposes the subagent as an inline factory with its standalone source intact", async () => {
    expect(BUNDLED_EXTENSION_FACTORIES).toHaveLength(1);
    expect(BUNDLED_EXTENSION_FACTORIES[0]).toMatchObject({ name: "pui-subagent" });
    expect(path.isAbsolute(BUNDLED_SUBAGENT_SOURCE_PATH)).toBe(true);
    expect((await fs.promises.stat(BUNDLED_SUBAGENT_SOURCE_PATH)).isFile()).toBe(true);
  });

  test("the controller runtime factory preserves one subagent tool across session replacement", async () => {
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
      expectOneBundledSubagent(runtime, initialCwd);

      expect((await runtime.newSession()).cancelled).toBe(false);
      expectOneBundledSubagent(runtime, initialCwd);

      const forkEntryId = runtime.session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Fork this in-memory session fixture." }],
        timestamp: Date.now(),
      });
      expect((await runtime.fork(forkEntryId)).cancelled).toBe(false);
      expectOneBundledSubagent(runtime, initialCwd);

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
      expectOneBundledSubagent(runtime, resumedCwd);
    } finally {
      await runtime.dispose();
      await fs.promises.rm(temp, { recursive: true, force: true });
    }
  });

  test("loads and reloads one subagent extension without disabling normal discovery", async () => {
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
        expect(result.extensions).toHaveLength(3);

        const bundled = result.extensions.filter(
          (extension) => extension.resolvedPath === bundledSubagentPath,
        );
        expect(bundled).toHaveLength(1);
        expect([...bundled[0]!.tools.keys()]).toEqual(["subagent"]);
        expect(result.extensions.flatMap((extension) => [...extension.commands.keys()]).sort()).toEqual([
          "global-fixture",
          "project-fixture",
        ]);
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
