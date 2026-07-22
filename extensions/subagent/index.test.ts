import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSubagentExtension } from "./index.ts";
import { createTerminalSubagentDetails, updateSubagentDetails } from "./protocol.ts";
import { AbortableSemaphore } from "./semaphore.ts";

const extensionCwd = path.dirname(fileURLToPath(import.meta.url));

type Handler = (event: any, ctx?: any) => any;

function fakePi() {
  let tool: any;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool(definition: any) {
      tool = definition;
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  return {
    pi: pi as any,
    get tool() {
      return tool;
    },
    handler(name: string) {
      const found = handlers.get(name)?.[0];
      if (!found) throw new Error(`Missing ${name} handler`);
      return found;
    },
  };
}

function successRun(output = "delegated answer") {
  return async (options: any) => {
    let details = updateSubagentDetails(options.details, {
      status: "running",
      phase: "thinking",
      startedAt: options.details.run.startedAt ?? Date.now(),
    });
    options.onSnapshot?.(details);
    details = createTerminalSubagentDetails(details, { status: "succeeded", outputPreview: output });
    options.onSnapshot?.(details);
    return { details, output, stderr: "", exitCode: 0, signal: null };
  };
}

function execute(tool: any, id: string, signal?: AbortSignal, onUpdate?: (value: any) => void) {
  return tool.execute(
    id,
    { agent: "explore", prompt: "Inspect the target", cwd: extensionCwd },
    signal,
    onUpdate,
    { cwd: extensionCwd },
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await Bun.sleep(2);
  }
}

describe("subagent extension integration", () => {
  test("preserves the public schema, outer id, child isolation flags, and lifecycle snapshots", async () => {
    const host = fakePi();
    let runnerOptions: any;
    registerSubagentExtension(host.pi, {
      semaphore: new AbortableSemaphore(4),
      invocation: (args) => ({ command: "fake-pi", args }),
      run: async (options) => {
        runnerOptions = options;
        return successRun()(options);
      },
    });
    const updates: any[] = [];

    const result = await execute(host.tool, "outer-call-42", undefined, (update) => updates.push(update));

    expect(host.tool.parameters.required).toEqual(["agent", "prompt", "cwd"]);
    expect(result.details.run.id).toBe("outer-call-42");
    expect(result.content[0].text).toBe("delegated answer");
    expect(updates.map((item) => item.details.run.status)).toEqual([
      "queued",
      "starting",
      "running",
      "succeeded",
    ]);
    expect(updates.every((item) => item.details.run.id === "outer-call-42")).toBe(true);
    expect(runnerOptions.command).toBe("fake-pi");
    expect(runnerOptions.args).toContain("--mode");
    expect(runnerOptions.args).toContain("json");
    for (const flag of [
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
    ]) {
      expect(runnerOptions.args).toContain(flag);
    }
    expect(runnerOptions.args.at(-1)).toBe("Inspect the target");
    expect(result.details.run.fullOutputPath).toBeUndefined();
  });

  test("regular Pi renderer shows token and turn usage without monetary cost", async () => {
    const host = fakePi();
    registerSubagentExtension(host.pi, {
      semaphore: new AbortableSemaphore(1),
      invocation: (args) => ({ command: "fake-pi", args }),
      run: successRun(),
    });
    const result = await execute(host.tool, "rendered-call");
    result.details = {
      ...result.details,
      run: {
        ...result.details.run,
        usage: { ...result.details.run.usage, turns: 2, totalTokens: 1234, cost: 0.5678 },
      },
    };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    const rendered = host.tool.renderResult(result, { expanded: false }, theme, { isError: false });
    const text = rendered.render(200).join("\n");
    expect(text).toContain("2 turns · 1234 tokens");
    expect(text).not.toContain("$");
    expect(text).not.toContain("0.5678");
  });

  test("stores full output privately only when model-visible output is truncated", async () => {
    const host = fakePi();
    const output = "😀".repeat(20_000);
    registerSubagentExtension(host.pi, {
      semaphore: new AbortableSemaphore(1),
      invocation: (args) => ({ command: "fake-pi", args }),
      run: successRun(output),
    });

    const result = await execute(host.tool, "truncated-call");
    const outputPath = result.details.run.fullOutputPath;
    expect(result.content[0].text).toContain("[Output truncated:");
    expect(outputPath).toBeString();
    expect(await fs.promises.readFile(outputPath, "utf8")).toBe(output);
    const mode = (await fs.promises.stat(outputPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    await fs.promises.rm(path.dirname(outputPath), { recursive: true, force: true });
  });

  test("throws failures and patches terminal details into the persisted tool result once", async () => {
    const host = fakePi();
    registerSubagentExtension(host.pi, {
      semaphore: new AbortableSemaphore(1),
      invocation: (args) => ({ command: "fake-pi", args }),
      run: async (options) => {
        let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
        options.onSnapshot?.(details);
        details = createTerminalSubagentDetails(details, { status: "failed", error: "actionable child failure" });
        options.onSnapshot?.(details);
        return { details, output: "", stderr: "fixture stderr", exitCode: 3, signal: null };
      },
    });

    await expect(execute(host.tool, "failed-call")).rejects.toThrow("actionable child failure");
    const handler = host.handler("tool_result");
    const patch = await handler({ toolCallId: "failed-call" });
    expect(patch.details.run.status).toBe("failed");
    expect(patch.details.run.error).toBe("actionable child failure");
    expect(await handler({ toolCallId: "failed-call" })).toBeUndefined();
  });

  test("runs four children while later calls remain visibly queued", async () => {
    const host = fakePi();
    const semaphore = new AbortableSemaphore(4);
    let active = 0;
    let maxActive = 0;
    registerSubagentExtension(host.pi, {
      semaphore,
      invocation: (args) => ({ command: "fake-pi", args }),
      run: async (options) => {
        active++;
        maxActive = Math.max(maxActive, active);
        let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
        options.onSnapshot?.(details);
        await Bun.sleep(30);
        details = createTerminalSubagentDetails(details, { status: "succeeded", outputPreview: "ok" });
        options.onSnapshot?.(details);
        active--;
        return { details, output: "ok", stderr: "", exitCode: 0, signal: null };
      },
    });
    const statuses = Array.from({ length: 5 }, () => [] as string[]);
    const executions = statuses.map((items, index) =>
      execute(host.tool, `call-${index}`, undefined, (update) => items.push(update.details.run.status)),
    );

    await waitUntil(() => semaphore.active === 4 && semaphore.queued === 1);
    const queuedIndex = statuses.findIndex((items) => items.length === 1 && items[0] === "queued");
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    await Promise.all(executions);
    expect(maxActive).toBe(4);
    expect(statuses[queuedIndex]).toEqual(["queued", "starting", "running", "succeeded"]);
    expect(semaphore.active).toBe(0);
  });

  test("queued calls can be cancelled without spawning", async () => {
    const host = fakePi();
    const semaphore = new AbortableSemaphore(1);
    const occupy = await semaphore.acquire();
    let runnerCalled = false;
    registerSubagentExtension(host.pi, {
      semaphore,
      invocation: (args) => ({ command: "fake-pi", args }),
      run: async (options) => {
        runnerCalled = true;
        return successRun()(options);
      },
    });
    const controller = new AbortController();
    const statuses: string[] = [];
    const execution = execute(host.tool, "queued-cancel", controller.signal, (update) => {
      statuses.push(update.details.run.status);
    });
    await waitUntil(() => semaphore.queued === 1);
    controller.abort();

    await expect(execution).rejects.toThrow("cancelled while queued");
    occupy();
    expect(runnerCalled).toBe(false);
    expect(statuses).toEqual(["queued", "cancelled"]);
    const patch = await host.handler("tool_result")({ toolCallId: "queued-cancel" });
    expect(patch.details.run.status).toBe("cancelled");
  });

  test("session shutdown aborts running work and leaves no saved failure state", async () => {
    const host = fakePi();
    const semaphore = new AbortableSemaphore(1);
    registerSubagentExtension(host.pi, {
      semaphore,
      invocation: (args) => ({ command: "fake-pi", args }),
      run: async (options) => {
        let details = updateSubagentDetails(options.details, { status: "running", phase: "thinking" });
        options.onSnapshot?.(details);
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        details = createTerminalSubagentDetails(details, { status: "cancelled", error: "shutdown cancellation" });
        options.onSnapshot?.(details);
        return { details, output: "", stderr: "", exitCode: null, signal: "SIGTERM" };
      },
    });
    const execution = execute(host.tool, "shutdown-call");
    await waitUntil(() => semaphore.active === 1);
    await host.handler("session_shutdown")({ type: "session_shutdown", reason: "quit" });

    await expect(execution).rejects.toThrow("shutdown cancellation");
    expect(semaphore.active).toBe(0);
    expect(await host.handler("tool_result")({ toolCallId: "shutdown-call" })).toBeUndefined();
  });
});
