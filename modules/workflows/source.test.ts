import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    executableWorkflowScript,
    MAX_WORKFLOW_SOURCE_BYTES,
    parseWorkflowEntrypoint,
    parseWorkflowMetadata,
    readWorkflowFile,
} from "./source.js";

describe("workflow file source", () => {
    test("resolves and canonicalizes paths, reads metadata, and derives a filename name", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            const plain = path.join(root, "My workflow.ts");
            const plainScript = "export default async function run(ctx, args) { return args }";
            await fs.promises.writeFile(plain, plainScript);
            expect(await readWorkflowFile(root, "My workflow.ts")).toMatchObject({
                path: await fs.promises.realpath(plain),
                name: "my-workflow",
                script: plainScript,
            });
            const metadata = path.join(root, "other.ts");
            await fs.promises.writeFile(
                metadata,
                `export const meta={name:"demo",description:"Demo"}; export default async function run(ctx, args) { return 1 }`,
            );
            expect(await readWorkflowFile("/", metadata)).toMatchObject({ name: "demo", description: "Demo" });
            const symlink = path.join(root, "linked.js");
            await fs.promises.symlink(plain, symlink);
            expect((await readWorkflowFile(root, "linked.js")).path).toBe(await fs.promises.realpath(plain));
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("requires the canonical target to have exactly a .ts extension", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            for (const extension of [".js", ".tsx", ".mts", ".cts"]) {
                const file = path.join(root, `workflow${extension}`);
                await fs.promises.writeFile(file, "export default async function run(ctx, args) {} ");
                await expect(readWorkflowFile(root, file)).rejects.toThrow("must use the .ts extension");
            }
            const target = path.join(root, "target.js");
            const alias = path.join(root, "alias.ts");
            await fs.promises.writeFile(target, "export default async function run(ctx, args) {} ");
            await fs.promises.symlink(target, alias);
            await expect(readWorkflowFile(root, alias)).rejects.toThrow(target);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("preserves exact valid UTF-8 source, including a BOM", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            const file = path.join(root, "exact.ts");
            const script = `\uFEFFconst greeting: string = "héllo";\r\nexport default async function run(ctx, args) { return greeting }`;
            await fs.promises.writeFile(file, Buffer.from(script, "utf8"));
            expect((await readWorkflowFile(root, file)).script).toBe(script);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("requires a regular file and enforces the exact byte limit", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            await expect(readWorkflowFile(root, ".")).rejects.toThrow("regular file");
            await expect(readWorkflowFile(root, "missing.ts")).rejects.toThrow();
            const file = path.join(root, "large.ts");
            const prefix = "export default async function run(ctx, args) {} /*";
            const suffix = "*/";
            const exact = prefix + "x".repeat(MAX_WORKFLOW_SOURCE_BYTES - prefix.length - suffix.length) + suffix;
            await fs.promises.writeFile(file, exact);
            expect((await readWorkflowFile(root, file)).script).toBe(exact);
            await fs.promises.appendFile(file, "x");
            await expect(readWorkflowFile(root, file)).rejects.toThrow("64 KiB");
            const invalid = path.join(root, "invalid.ts");
            await fs.promises.writeFile(invalid, Buffer.from([0xff]));
            await expect(readWorkflowFile(root, invalid)).rejects.toThrow("valid UTF-8");
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    test("validates and converts the single exported async entrypoint", () => {
        const source = `import type { WorkflowContext, WorkflowMetadata } from "pui/workflow";\nexport const meta = { name: "demo", description: "Demo" } satisfies WorkflowMetadata;\nexport default async function run(ctx: WorkflowContext, args: unknown) { return args }`;
        expect(parseWorkflowEntrypoint(source)).toMatchObject({ name: "run" });
        const executable = executableWorkflowScript(source, "function");
        expect(executable).not.toContain("export default");
        expect(executable).not.toContain("export const meta");
        expect(executable).not.toContain("import type");
        expect(executable).toEndWith("return await run(__puiWorkflowContext, __puiWorkflowArgs);");
    });

    test("rejects missing, multiple, wrong exports, and imports without false positives", () => {
        expect(() => parseWorkflowEntrypoint("async function run(ctx, args) {}")).toThrow("exactly one");
        expect(() => parseWorkflowEntrypoint("export function run(ctx, args) {}")).toThrow("exactly one");
        expect(() =>
            parseWorkflowEntrypoint("export async function one() {}\nexport default async function two() {}"),
        ).toThrow("only the default async workflow function");
        expect(() => parseWorkflowEntrypoint("export const other = 1; export default async function run() {}")).toThrow(
            "only the default async workflow function",
        );
        expect(() =>
            parseWorkflowEntrypoint('import type { X } from "other"; export default async function run() {}'),
        ).toThrow("only import type");
        expect(() =>
            parseWorkflowEntrypoint('import { X } from "pui/workflow"; export default async function run() {}'),
        ).toThrow("only import type");
        expect(() =>
            parseWorkflowEntrypoint(
                'import type {\n    WorkflowContext,\n} from "pui/workflow";\nexport default async function run() {}',
            ),
        ).not.toThrow();
        expect(
            parseWorkflowEntrypoint(
                `// export async function fake() {}\nconst text = "export default async function fake() {}";\nexport default async function real() {}`,
            ).name,
        ).toBe("real");
        expect(
            parseWorkflowEntrypoint(
                `const words = /import|export|[{}]/g;\n/export/.test("export");\nexport default async function real() { return words }`,
            ).name,
        ).toBe("real");
    });

    test("requires the file contract while leaving inline executable bodies supported", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-wf-source-"));
        try {
            const file = path.join(root, "missing.ts");
            await fs.promises.writeFile(file, "return args");
            await expect(readWorkflowFile(root, file)).rejects.toThrow("exactly one");
            expect(executableWorkflowScript("return args")).toBe("return args");
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
            parseWorkflowMetadata(`export const meta={name:'demo',description:'bad\\q'}`, "example.ts"),
        ).toThrow("example.ts: meta contains an unsupported string escape \\q");
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
            `if (true) {}\n/export const meta =/.test("x");`,
            `while (ok) {}\n/export const meta =/.test(text)`,
            `if (ok) { run() } else {}\n/export const meta =/.test(text)`,
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

    test("keeps regex statements after declaration bodies inert", () => {
        const regexStatements = [
            `function f() {}\n/export const meta =/.test("x")`,
            `async function f() {}\n/export const meta =/.test("x")`,
            `function* f() {}\n/export const meta =/.test("x")`,
            `class Example {} /export const meta =/.test("x")`,
            `export class Example {} /export const meta =/.test("x")`,
            `export default class Example {} /export const meta =/.test("x")`,
            `class Example extends Base {} /export const meta =/.test("x")`,
            `export default class extends Base {} /export const meta =/.test("x")`,
        ];
        for (const script of regexStatements) {
            expect(() => parseWorkflowMetadata(script)).toThrow("exactly one");
            expect(
                parseWorkflowMetadata(`${script}\nexport const meta={name:"demo",description:"Demo"}`),
            ).toMatchObject({ name: "demo" });
        }
    });

    test("keeps division after object and class expressions distinct from regex statements", () => {
        const metadata = `export const meta={name:"demo",description:"Demo"}`;
        expect(parseWorkflowMetadata(`const ratio = {} / export / constValue;\n${metadata}`)).toMatchObject({
            name: "demo",
        });
        expect(parseWorkflowMetadata(`const ratio = class {} / export / constValue;\n${metadata}`)).toMatchObject({
            name: "demo",
        });
    });
});
