import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileWorkflowApprovalStore } from "./approval.js";

const temporary = () => fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-approvals-"));

describe("FileWorkflowApprovalStore", () => {
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
