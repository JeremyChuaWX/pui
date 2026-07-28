import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkflows, parseWorkflowMetadata, saveWorkflow } from "./storage.js";

const source = (name: string, marker = name) =>
    `export const meta = {name: "${name}", description: "${marker}"};\nglobalThis.__discoveryExecuted=true; return args;`;
async function fixture() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-store-"));
    await fs.promises.mkdir(path.join(root, ".git"));
    return root;
}
async function put(dir: string, file: string, text: string) {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, file), text);
}

describe("saved workflow storage", () => {
    test("discovers nearest through repository root then personal without execution", async () => {
        const root = await fixture(),
            nested = path.join(root, "a", "b"),
            home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-home-"));
        await fs.promises.mkdir(nested, { recursive: true });
        try {
            await put(path.join(root, ".pi/workflows"), "same.js", source("same", "root"));
            await put(path.join(root, "a/.pi/workflows"), "same.js", source("same", "near"));
            await put(path.join(home, ".pi/agent/workflows"), "same.js", source("same", "personal"));
            await put(path.join(home, ".pi/agent/workflows"), "fallback.js", source("fallback"));
            delete (globalThis as any).__discoveryExecuted;
            const found = await discoverWorkflows(nested, { home });
            expect(found.find((x) => x.name === "same")?.description).toBe("near");
            expect(found.find((x) => x.name === "fallback")?.scope).toBe("personal");
            expect((globalThis as any).__discoveryExecuted).toBeUndefined();
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
            await fs.promises.rm(home, { recursive: true, force: true });
        }
    });
    test("stops at repository boundary", async () => {
        const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-boundary-")),
            root = path.join(parent, "repository"),
            home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-home-"));
        const outside = path.join(parent, ".pi/workflows");
        try {
            await fs.promises.mkdir(path.join(root, ".git"), { recursive: true });
            await put(outside, "outside.js", source("outside"));
            expect((await discoverWorkflows(root, { home })).some((x) => x.name === "outside")).toBe(false);
        } finally {
            await fs.promises.rm(parent, { recursive: true, force: true });
            await fs.promises.rm(home, { recursive: true, force: true });
        }
    });
    test("rejects invalid and duplicate metadata/collisions", async () => {
        expect(() => parseWorkflowMetadata("export const meta={name:'Bad',description:'x'}")).toThrow("Invalid");
        expect(() =>
            parseWorkflowMetadata(
                "export const meta={name:'a',description:'x'}; export const meta={name:'b',description:'x'}",
            ),
        ).toThrow("exactly one");
        const root = await fixture(),
            home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-home-"));
        try {
            await put(path.join(root, ".pi/workflows"), "a.js", source("same"));
            await put(path.join(root, ".pi/workflows"), "b.js", source("same"));
            await expect(discoverWorkflows(root, { home })).rejects.toThrow("collision");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
            await fs.promises.rm(home, { recursive: true, force: true });
        }
    });
    test("atomically saves immutable bytes, requires overwrite, and rejects directory/file symlinks", async () => {
        const root = await fixture(),
            home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-home-"));
        try {
            const script = source("demo");
            const file = await saveWorkflow({ cwd: root, name: "demo", script, scope: "project" }, { home });
            expect(await fs.promises.readFile(file, "utf8")).toBe(script);
            await expect(saveWorkflow({ cwd: root, name: "demo", script, scope: "project" }, { home })).rejects.toThrow(
                "overwrite",
            );
            await saveWorkflow(
                { cwd: root, name: "demo", script: source("demo", "new"), scope: "project", overwrite: true },
                { home },
            );
            expect(await fs.promises.readFile(file, "utf8")).toContain("new");
            await fs.promises.rm(path.join(root, ".pi"), { recursive: true });
            await fs.promises.symlink(home, path.join(root, ".pi"));
            await expect(
                saveWorkflow({ cwd: root, name: "x", script: source("x"), scope: "project" }, { home }),
            ).rejects.toThrow("Unsafe");
            await fs.promises.rm(path.join(root, ".pi"), { force: true });
            await fs.promises.mkdir(path.join(root, ".pi/workflows"), { recursive: true });
            await fs.promises.symlink(path.join(home, "x"), path.join(root, ".pi/workflows/x.js"));
            await expect(
                saveWorkflow(
                    { cwd: root, name: "x", script: source("x"), scope: "project", overwrite: true },
                    { home },
                ),
            ).rejects.toThrow("Unsafe");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
            await fs.promises.rm(home, { recursive: true, force: true });
        }
    });
});
