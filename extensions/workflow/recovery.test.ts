import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowBackend } from "./backend.js";
import { parseWorkflowRunV1 } from "./protocol.js";
import { WorkflowRunStorage } from "./run-storage.js";

async function waitFor(predicate: () => boolean, timeout = 5_000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > end) throw new Error("timeout");
        await Bun.sleep(10);
    }
}

const increment = (counts: Map<string, number>, prompt: string) => counts.set(prompt, (counts.get(prompt) ?? 0) + 1);

test("explicit stop is terminal and is not resumable after restart", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-stop-"));
    const project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    await Bun.$`git init -q ${project}`;
    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => (started = resolve));
    const backendA = createWorkflowBackend({
        storage,
        cooperativeExecutor: true,
        agentExecutor: ({ signal }) =>
            new Promise((_resolve, reject) => {
                started();
                signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
            }),
    });
    let backendB: ReturnType<typeof createWorkflowBackend> | undefined;
    try {
        const { runId } = await backendA.launch({
            name: "stop",
            script: `return await agent("blocked")`,
            sessionId: "stop-test",
            cwd: project,
        });
        await agentStarted;
        await backendA.control(runId, "stop");
        await waitFor(() => backendA.inspect(runId).run.status === "cancelled");
        await backendA.shutdown();
        const [durable] = await storage.discover(project);
        expect(await fs.promises.readFile(path.join(durable!.directory, "workflow.js"), "utf8")).toBe(
            `return await agent("blocked")`,
        );

        backendB = createWorkflowBackend({ storage, agentExecutor: async () => ({ value: "unexpected" }) });
        const initialized = await backendB.initialize!(project);
        expect(initialized.find((run) => run.id === runId)?.status).toBe("cancelled");
        await backendB.recover!(runId);
        expect(backendB.inspect(runId).run.status).toBe("cancelled");
        const [stored] = await storage.discover(project);
        expect(await fs.promises.stat(path.join(stored!.directory, "summary.json"))).toBeTruthy();
        expect(await fs.promises.stat(path.join(stored!.directory, "result.json"))).toBeTruthy();
    } finally {
        await Promise.allSettled([backendA.shutdown(), backendB?.shutdown() ?? Promise.resolve()]);
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});

test("recovers from a durable completion without executing it twice", async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-recovery-"));
    const project = path.join(temp, "project");
    await fs.promises.mkdir(project);
    await Bun.$`git init -q ${project}`;

    const storage = new WorkflowRunStorage(path.join(temp, "runs"));
    const countsA = new Map<string, number>();
    const countsB = new Map<string, number>();
    let releaseHook!: () => void;
    let durable!: () => void;
    const blocked = new Promise<void>((resolve) => (releaseHook = resolve));
    const firstDurable = new Promise<void>((resolve) => (durable = resolve));
    let completion = 0;
    const backendA = createWorkflowBackend({
        storage,
        agentExecutor: async ({ prompt }) => {
            increment(countsA, prompt);
            return { value: `${prompt}-result` };
        },
        afterDurableCompletion: async () => {
            if (++completion === 1) {
                durable();
                await blocked;
            }
        },
    });
    let backendB: ReturnType<typeof createWorkflowBackend> | undefined;

    try {
        const blockingScript = `const first=await agent("first"); const second=await agent("second"); return {first,second}`;
        const { runId } = await backendA.launch({
            name: "recovery",
            script: blockingScript,
            sessionId: "recovery-test",
            cwd: project,
        });
        await Promise.race([
            firstDurable,
            Bun.sleep(5_000).then(() => {
                throw new Error("first completion was not made durable");
            }),
        ]);

        await Promise.race([
            backendA.shutdown(),
            Bun.sleep(2_000).then(() => {
                throw new Error("backend shutdown did not cooperatively stop");
            }),
        ]);
        let [interruptedStored] = await storage.discover(project);
        expect(interruptedStored?.snapshot.status).toBe("paused");
        expect(interruptedStored?.snapshot.warning).toContain("resume after restart");
        expect(interruptedStored?.snapshot.endedAt).toBeUndefined();
        expect(
            await fs.promises.stat(path.join(interruptedStored!.directory, "summary.json")).catch(() => undefined),
        ).toBeUndefined();
        expect(
            await fs.promises.stat(path.join(interruptedStored!.directory, "result.json")).catch(() => undefined),
        ).toBeUndefined();
        releaseHook();
        await fs.promises.rename(
            path.join(interruptedStored!.directory, "workflow.js"),
            path.join(interruptedStored!.directory, "workflow.ts"),
        );
        [interruptedStored] = await storage.discover(project);
        expect(interruptedStored?.corrupt).toBeUndefined();
        expect(interruptedStored?.launch.script).toBe(blockingScript);

        backendB = createWorkflowBackend({
            storage,
            agentExecutor: async ({ prompt }) => {
                increment(countsB, prompt);
                return { value: `${prompt}-result` };
            },
        });
        const interrupted = await backendB.initialize!(project);
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]?.id).toBe(runId);
        expect(interrupted[0]?.status).not.toBe("succeeded");

        await backendB.recover!(runId);
        expect(backendB.inspect(runId).run.warning).toBeUndefined();
        await waitFor(() => backendB!.inspect(runId).run.status === "succeeded");
        await backendB.claimTerminalDelivery!(runId);
        expect(JSON.parse(backendB.inspect(runId).result!)).toEqual({
            first: "first-result",
            second: "second-result",
        });
        expect((countsA.get("first") ?? 0) + (countsB.get("first") ?? 0)).toBe(1);
        expect((countsA.get("second") ?? 0) + (countsB.get("second") ?? 0)).toBe(1);

        const [stored] = await storage.discover(project);
        expect(parseWorkflowRunV1(stored?.snapshot)).toEqual(stored?.snapshot);
        const journal = (await fs.promises.readFile(path.join(stored!.directory, "journal.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.type === "completed");
        expect(journal).toHaveLength(2);
        expect(new Set(journal.map((entry) => entry.operation)).size).toBe(2);
    } finally {
        releaseHook();
        await Promise.allSettled([backendA.shutdown(), backendB?.shutdown() ?? Promise.resolve()]);
        await fs.promises.rm(temp, { recursive: true, force: true });
    }
});
