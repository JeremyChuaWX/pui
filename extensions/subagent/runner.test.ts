import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialSubagentDetails, updateSubagentDetails, type SubagentDetailsV1 } from "./protocol.ts";
import { getPiInvocation, runSubagent } from "./runner.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const cwd = path.dirname(fixture);

function startingDetails(id = "outer-id"): SubagentDetailsV1 {
  const initial = createInitialSubagentDetails({ id, agent: "explore", model: "fixture/model", cwd, now: Date.now() });
  return updateSubagentDetails(initial, { status: "starting", phase: "spawning", startedAt: Date.now() });
}

async function runFixture(
  scenario: string,
  options: Partial<Parameters<typeof runSubagent>[0]> = {},
) {
  const snapshots: SubagentDetailsV1[] = [];
  const result = await runSubagent({
    details: startingDetails(),
    command: process.execPath,
    args: [fixture, scenario],
    cwd,
    timeoutMs: 2_000,
    throttleMs: 5,
    killGraceMs: 20,
    onSnapshot: (details) => snapshots.push(details),
    ...options,
  });
  return { result, snapshots };
}

describe("runSubagent", () => {
  test("streams fragmented JSONL, tracks parallel tools, and aggregates each assistant once", async () => {
    const { result, snapshots } = await runFixture("success");

    expect(result.details.run.status).toBe("succeeded");
    expect(result.output).toBe("Final child report");
    expect(result.details.run.model).toBe("fixture/model");
    expect(result.details.run.usage).toEqual({
      input: 30,
      output: 6,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 40,
      cost: 0.03,
      turns: 2,
    });
    expect(snapshots.some((item) => item.run.activeTools.length === 2)).toBe(true);
    expect(
      snapshots.some(
        (item) => item.run.activeTools.length === 1 && item.run.activeTools[0]?.id === "tool-a",
      ),
    ).toBe(true);
    expect(result.details.run.activeTools).toEqual([]);
    expect(snapshots.at(-1)?.run.status).toBe("succeeded");
  });

  test("keeps malformed output as a bounded diagnostic without crashing", async () => {
    const { result } = await runFixture("malformed-success");
    expect(result.details.run.status).toBe("succeeded");
    expect(result.output).toBe("recovered output");
    expect(result.details.run.recentActivity.some((item) => item.kind === "diagnostic" && item.title.includes("malformed"))).toBe(true);
  });

  test("fails actionably when no final assistant response is emitted", async () => {
    const { result } = await runFixture("no-final");
    expect(result.details.run.status).toBe("failed");
    expect(result.details.run.error).toContain("without a final assistant response");
  });

  test("rejects an invalid finalized assistant message without crashing", async () => {
    const { result } = await runFixture("invalid-final");
    expect(result.details.run.status).toBe("failed");
    expect(result.details.run.error).toContain("without a final assistant response");
    expect(result.details.run.recentActivity.some((item) => item.title.includes("invalid finalized"))).toBe(true);
  });

  test("includes bounded stderr in nonzero-exit diagnostics", async () => {
    const { result } = await runFixture("failure");
    expect(result.details.run.status).toBe("failed");
    expect(result.details.run.error).toContain("exit code 7");
    expect(result.details.run.error).toContain("fixture child failed actionably");
  });

  test("distinguishes timeout from user cancellation and force-kills stubborn children", async () => {
    const timedOut = await runFixture("hang", { timeoutMs: 25 });
    expect(timedOut.result.details.run.status).toBe("timed_out");
    expect(timedOut.result.details.run.error).toContain("timed out");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = await runFixture("hang", { timeoutMs: 5_000, signal: controller.signal });
    expect(cancelled.result.details.run.status).toBe("cancelled");
    expect(cancelled.result.details.run.error).toContain("cancelled");
  });

  test("kills descendants in the child process group on timeout", async () => {
    const { result } = await runFixture("descendant-hang", { timeoutMs: 40 });
    const pid = Number(result.stderr.match(/descendant:(\d+)/)?.[1]);
    expect(result.details.run.status).toBe("timed_out");
    expect(pid).toBeGreaterThan(0);

    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(10);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test("bounds stderr and emits no progress after settlement", async () => {
    const snapshots: SubagentDetailsV1[] = [];
    const { result } = await runFixture("large-stderr-failure", {
      onSnapshot: (details) => snapshots.push(details),
    });
    const countAtSettlement = snapshots.length;
    await Bun.sleep(30);

    expect(result.details.run.status).toBe("failed");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(snapshots).toHaveLength(countAtSettlement);
  });

  test("ignores progress callback errors without stranding the child", async () => {
    const { result } = await runFixture("success", {
      onSnapshot: () => {
        throw new Error("renderer failed");
      },
    });
    expect(result.details.run.status).toBe("succeeded");
    expect(result.output).toBe("Final child report");
  });

  test("returns structured failure for a spawn error", async () => {
    const { result } = await runSubagent({
      details: startingDetails(),
      command: path.join(cwd, "does-not-exist"),
      args: [],
      cwd,
      timeoutMs: 100,
    }).then((result) => ({ result }));
    expect(result.details.run.status).toBe("failed");
    expect(result.details.run.error).toContain("Unable to start child Pi");
  });
});

describe("getPiInvocation", () => {
  test("does not reuse an SDK host entrypoint", () => {
    const invocation = getPiInvocation(["--mode", "json"], fixture, process.execPath);
    expect(invocation).toEqual({ command: "pi", args: ["--mode", "json"] });
  });

  test("reuses Pi's own CLI entrypoint", () => {
    const cli = path.join(
      cwd,
      "..",
      "..",
      "..",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    const invocation = getPiInvocation(["--mode", "json"], cli, "/usr/bin/node");
    expect(invocation).toEqual({ command: "/usr/bin/node", args: [cli, "--mode", "json"] });
  });
});
