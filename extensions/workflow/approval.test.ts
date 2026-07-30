import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileWorkflowApprovalStore, workflowApprovalKey } from "./approval.js";

const temporary = () => fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-approvals-"));

describe("FileWorkflowApprovalStore", () => {
    test("versions approval keys when workflow host capabilities change", async () => {
        const root = await temporary();
        const script = "return 1";
        const legacyHash = createHash("sha256").update(Buffer.from(script)).digest("hex");
        const legacyKey = `project\0source\0${legacyHash}`;
        const key = workflowApprovalKey("project", "source", script);
        try {
            expect(key).not.toEndWith(legacyHash);
            expect(key).toBe(workflowApprovalKey("project", "source", script));
            expect(key).not.toBe(workflowApprovalKey("project", "source", "return 2"));

            const store = new FileWorkflowApprovalStore(path.join(root, "store.json"), root);
            await store.add(legacyKey);
            expect(await store.has(key)).toBe(false);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("rejects parent and file symlinks", async () => {
        const root = await temporary();
        try {
            const outside = await temporary();
            await fs.promises.symlink(outside, path.join(root, "linked"));
            await expect(
                new FileWorkflowApprovalStore(path.join(root, "linked/store.json"), root).add("key"),
            ).rejects.toThrow("Unsafe approval directory");
            const target = path.join(root, "target.json");
            await fs.promises.writeFile(target, JSON.stringify({ version: 1, keys: [] }));
            await fs.promises.symlink(target, path.join(root, "store.json"));
            await expect(new FileWorkflowApprovalStore(path.join(root, "store.json"), root).has("key")).rejects.toThrow(
                "Unsafe workflow approval store",
            );
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("a stale owner cannot release a replacement lock", async () => {
        const root = await temporary();
        const file = path.join(root, "store.json"),
            lock = `${file}.lock`,
            first = new FileWorkflowApprovalStore(file, root),
            second = new FileWorkflowApprovalStore(file, root);
        let releaseFirst: (() => Promise<void>) | undefined, releaseSecond: (() => Promise<void>) | undefined;
        try {
            const firstRelease = (await (first as any).acquireLock()) as () => Promise<void>;
            releaseFirst = firstRelease;
            const ownerFile = path.join(lock, "owner.json"),
                owner = JSON.parse(await fs.promises.readFile(ownerFile, "utf8")),
                old = new Date(Date.now() - 120_000),
                exited = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }),
                deadPid = exited.pid;
            if (!deadPid) throw new Error("Expected approval lock fixture pid");
            await new Promise<void>((resolve, reject) => {
                exited.once("error", reject);
                exited.once("exit", (code) =>
                    code === 0 ? resolve() : reject(new Error(`dead-pid fixture exited ${code}`)),
                );
            });
            await fs.promises.writeFile(ownerFile, JSON.stringify({ ...owner, pid: deadPid, host: os.hostname() }));
            await fs.promises.utimes(lock, old, old);
            const secondRelease = (await (second as any).acquireLock()) as () => Promise<void>;
            releaseSecond = secondRelease;
            await firstRelease();
            releaseFirst = undefined;
            expect((await fs.promises.lstat(lock)).isDirectory()).toBe(true);
            await secondRelease();
            releaseSecond = undefined;
            await expect(fs.promises.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await releaseFirst?.().catch(() => {});
            await releaseSecond?.().catch(() => {});
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("retains additions made concurrently by separate processes", async () => {
        const root = await temporary();
        const file = path.join(root, "store.json");
        const gate = path.join(root, "gate");
        const keys = Array.from({ length: 12 }, (_, index) => `process-key-${index}`);
        const children: ReturnType<typeof spawn>[] = [],
            completions: Promise<void>[] = [];
        let childFailure: Error | undefined;
        try {
            children.push(
                ...keys.map((key, index) =>
                    spawn(
                        process.execPath,
                        [
                            path.join(import.meta.dir, "approval-process-helper.ts"),
                            file,
                            root,
                            key,
                            path.join(root, `ready-${index}`),
                            gate,
                        ],
                        { stdio: "ignore" },
                    ),
                ),
            );
            completions.push(
                ...children.map(
                    (child) =>
                        new Promise<void>((resolve) => {
                            let settled = false;
                            const finish = (error?: Error) => {
                                if (settled) return;
                                settled = true;
                                childFailure ??= error;
                                resolve();
                            };
                            child.once("error", finish);
                            child.once("exit", (code) =>
                                finish(code === 0 ? undefined : new Error(`helper exited ${code}`)),
                            );
                        }),
                ),
            );
            const readyDeadline = Date.now() + 25_000;
            while ((await fs.promises.readdir(root)).filter((name) => name.startsWith("ready-")).length < keys.length) {
                if (childFailure) throw childFailure;
                if (Date.now() >= readyDeadline) throw new Error("Timed out waiting for approval helper readiness");
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            await fs.promises.writeFile(gate, "");
            await Promise.all(completions);
            if (childFailure) throw childFailure;
            expect(new Set(JSON.parse(await fs.promises.readFile(file, "utf8")).keys)).toEqual(new Set(keys));
        } finally {
            for (const child of children) {
                if (child.exitCode === null && child.signalCode === null) child.kill();
            }
            await Promise.all(completions);
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    }, 60_000);

    test("serializes concurrent additions without losing keys", async () => {
        const root = await temporary();
        const file = path.join(root, "store.json");
        const stores = [new FileWorkflowApprovalStore(file, root), new FileWorkflowApprovalStore(file, root)];
        try {
            const keys = Array.from({ length: 100 }, (_, index) => `key-${index}`);
            await Promise.all(keys.map((key, index) => stores[index % stores.length]!.add(key)));
            expect(new Set(JSON.parse(await fs.promises.readFile(file, "utf8")).keys)).toEqual(new Set(keys));
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("rejects writes beyond the key cap without corrupting the store", async () => {
        const root = await temporary();
        const file = path.join(root, "store.json");
        const keys = Array.from({ length: 10_000 }, (_, index) => `key-${index}`);
        try {
            await fs.promises.writeFile(file, JSON.stringify({ version: 1, keys }));
            const store = new FileWorkflowApprovalStore(file, root);
            await expect(store.add("overflow")).rejects.toThrow("limited to 10,000 keys");
            expect(await store.has(keys[0])).toBe(true);
            await expect(store.add(keys[0])).resolves.toBeUndefined();
            const unchanged = JSON.parse(await fs.promises.readFile(file, "utf8")).keys;
            expect(unchanged).toHaveLength(10_000);
            expect(unchanged).toContain(keys[0]);
            await fs.promises.writeFile(file, JSON.stringify({ version: 1, keys: [...keys, "overflow"] }));
            await expect(store.has(keys[0])).rejects.toThrow("Corrupt workflow approval store");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("fails closed on corruption and bounds, and writes privately and atomically", async () => {
        const root = await temporary();
        const file = path.join(root, "private", "store.json");
        const store = new FileWorkflowApprovalStore(file, root);
        try {
            await store.add("key");
            expect(await store.has("key")).toBe(true);
            expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
            expect((await fs.promises.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
            await fs.promises.writeFile(file, "not json");
            await expect(store.has("key")).rejects.toThrow();
            await fs.promises.writeFile(file, JSON.stringify({ version: 1, keys: ["x".repeat(8_001)] }));
            await expect(store.has("key")).rejects.toThrow("Corrupt workflow approval store");
            await fs.promises.writeFile(file, "x".repeat(1024 * 1024 + 1));
            await expect(store.has("key")).rejects.toThrow("Unsafe workflow approval store");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });
});
