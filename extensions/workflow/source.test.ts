import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_WORKFLOW_SOURCE_BYTES, parseWorkflowMetadata, readWorkflowFile } from "./source.js";

describe("workflow file source", () => {
    test("resolves and canonicalizes paths, reads metadata, and derives a filename name", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            const plain = path.join(root, "My workflow.js");
            await fs.promises.writeFile(plain, "return args");
            expect(await readWorkflowFile(root, "My workflow.js")).toMatchObject({
                path: await fs.promises.realpath(plain),
                name: "my-workflow",
                script: "return args",
            });
            const metadata = path.join(root, "other.js");
            await fs.promises.writeFile(metadata, `export const meta={name:"demo",description:"Demo"}; return 1`);
            expect(await readWorkflowFile("/", metadata)).toMatchObject({ name: "demo", description: "Demo" });
            const symlink = path.join(root, "linked.js");
            await fs.promises.symlink(plain, symlink);
            expect((await readWorkflowFile(root, "linked.js")).path).toBe(await fs.promises.realpath(plain));
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("requires a regular file and enforces the exact byte limit", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            await expect(readWorkflowFile(root, ".")).rejects.toThrow("regular file");
            await expect(readWorkflowFile(root, "missing.js")).rejects.toThrow();
            const file = path.join(root, "large.js");
            await fs.promises.writeFile(file, "é".repeat(MAX_WORKFLOW_SOURCE_BYTES / 2));
            expect((await readWorkflowFile(root, file)).script).toHaveLength(MAX_WORKFLOW_SOURCE_BYTES / 2);
            await fs.promises.appendFile(file, "x");
            await expect(readWorkflowFile(root, file)).rejects.toThrow("64 KiB");
            const invalid = path.join(root, "invalid.js");
            await fs.promises.writeFile(invalid, Buffer.from([0xff]));
            await expect(readWorkflowFile(root, invalid)).rejects.toThrow("valid UTF-8");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("parses static metadata without evaluating source", () => {
        expect(
            parseWorkflowMetadata(`export const meta={name:'demo',description:'Demo'}; throw new Error()`),
        ).toMatchObject({ name: "demo" });
        expect(() => parseWorkflowMetadata("return 1")).toThrow("exactly one");
        expect(() =>
            parseWorkflowMetadata(`export const meta={name:'demo',description:'bad\\q'}`, "example.js"),
        ).toThrow("example.js: meta contains an unsupported string escape \\q");
    });

    test("ignores metadata-like text outside a top-level declaration", () => {
        const inert = [
            `// export const meta={name:"wrong",description:"Wrong"}`,
            `/* export const meta={name:"wrong",description:"Wrong"} */`,
            `const string = 'export const meta={name:"wrong",description:"Wrong"}'`,
            'const template = `export const meta={name:"wrong",description:"Wrong"}`',
            `const regex = /export const meta = {name:"wrong"}/`,
            `function nested() { export const meta={name:"wrong",description:"Wrong"} }`,
        ].join("\n");
        expect(parseWorkflowMetadata(`${inert}\nexport const meta={name:"demo",description:"Demo"}`)).toMatchObject({
            name: "demo",
        });
        expect(() => parseWorkflowMetadata(inert)).toThrow("exactly one");
    });

    test("ignores metadata-like text in regex statements after control flow", () => {
        const regexStatements = [
            `if (ok) /export const meta =/.test(text)`,
            `while (ok) /export const meta =/.test(text)`,
            `for (; ok; ) /export const meta =/.test(text)`,
            `if (ok) run(); else /export const meta =/.test(text)`,
            `do /export const meta =/.test(text); while (ok)`,
            `return /export const meta =/.test(text)`,
        ].join("\n");
        const metadata = `export const meta={name:"demo",description:"Demo"}`;

        expect(parseWorkflowMetadata(`${regexStatements}\n${metadata}`)).toMatchObject({ name: "demo" });
        expect(() => parseWorkflowMetadata(regexStatements)).toThrow("exactly one");
    });
});
