import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_SAVED_WORKFLOW_BYTES = 64 * 1024;
export const WORKFLOW_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SavedWorkflow {
    name: string;
    description: string;
    script: string;
    path: string;
    scope: "project" | "personal";
    projectRoot?: string;
}
export interface WorkflowStorageOptions {
    home?: string;
    repositoryRoot?: (cwd: string) => Promise<string | undefined>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function validateWorkflowName(name: string): void {
    if (!WORKFLOW_NAME_PATTERN.test(name))
        throw new Error(`Invalid workflow name "${name}". Use 1-64 lowercase letters, digits, and single hyphens.`);
}

export interface WorkflowMetadata {
    name: string;
    description: string;
    declarationStart: number;
    declarationEnd: number;
}
const JS_STRING = String.raw`("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;
function parseStaticString(literal: string, source: string): string {
    if (literal.startsWith('"')) return JSON.parse(literal);
    let result = "";
    for (let index = 1; index < literal.length - 1; index++) {
        const character = literal[index]!;
        if (character !== "\\") {
            result += character;
            continue;
        }
        const escaped = literal[++index];
        if (escaped === undefined) throw new Error(`${source}: meta contains an invalid escaped string literal.`);
        const simple: Record<string, string> = {
            "'": "'",
            '"': '"',
            "\\": "\\",
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            v: "\v",
            "0": "\0",
        };
        if (!(escaped in simple))
            throw new Error(`${source}: meta contains an unsupported string escape \\${escaped}.`);
        result += simple[escaped];
    }
    return result;
}
/** Parse static metadata without importing or evaluating workflow code. */
export function parseWorkflowMetadata(script: string, source = "workflow"): WorkflowMetadata {
    const declarations = [...script.matchAll(/\bexport\s+const\s+meta\s*=/g)];
    if (declarations.length !== 1)
        throw new Error(`${source}: expected exactly one static export const meta declaration.`);
    const declaration = declarations[0]!,
        start = declaration.index!,
        tail = script.slice(start);
    const expression = new RegExp(
        String.raw`^export\s+const\s+meta\s*=\s*\{\s*name\s*:\s*${JS_STRING}\s*,\s*description\s*:\s*${JS_STRING}\s*,?\s*\}\s*;?`,
    ).exec(tail);
    if (!expression)
        throw new Error(
            `${source}: meta must be a static { name: "...", description: "..." } object using JSON string literals.`,
        );
    let name: string, description: string;
    try {
        name = parseStaticString(expression[1]!, source);
        description = parseStaticString(expression[2]!, source);
    } catch {
        throw new Error(`${source}: meta contains an invalid escaped string literal.`);
    }
    validateWorkflowName(name);
    if (!description.trim() || description.length > 512)
        throw new Error(`${source}: meta.description must contain 1-512 characters.`);
    return { name, description, declarationStart: start, declarationEnd: start + expression[0].length };
}

export function executableWorkflowScript(script: string): string {
    if (!/\bexport\s+const\s+meta\s*=/.test(script)) return script;
    const meta = parseWorkflowMetadata(script);
    return script.slice(0, meta.declarationStart) + script.slice(meta.declarationEnd);
}

export async function findRepositoryRoot(cwd: string): Promise<string | undefined> {
    let current = await fs.promises.realpath(cwd);
    for (;;) {
        try {
            await fs.promises.lstat(path.join(current, ".git"));
            return current;
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

async function assertPlainDirectory(directory: string, boundary: string): Promise<void> {
    const relative = path.relative(boundary, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Workflow path escapes ${boundary}.`);
    let current = boundary;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Unsafe workflow directory symlink: ${current}`);
        if (!stat.isDirectory()) throw new Error(`Workflow path is not a directory: ${current}`);
    }
}

async function readLevel(directory: string, boundary: string, scope: SavedWorkflow["scope"], projectRoot?: string) {
    try {
        await assertPlainDirectory(directory, boundary);
    } catch (error: any) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
    const definitions: SavedWorkflow[] = [];
    const names = new Map<string, string>();
    for (const entry of (await fs.promises.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
    )) {
        if (!entry.name.endsWith(".js")) continue;
        const file = path.join(directory, entry.name);
        const stat = await fs.promises.lstat(file);
        if (stat.isSymbolicLink()) throw new Error(`Unsafe workflow file symlink: ${file}`);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_SAVED_WORKFLOW_BYTES) throw new Error(`${file}: workflow exceeds the 64 KiB limit.`);
        const script = await fs.promises.readFile(file, "utf8");
        if (Buffer.byteLength(script) > MAX_SAVED_WORKFLOW_BYTES)
            throw new Error(`${file}: workflow exceeds the 64 KiB limit.`);
        const meta = parseWorkflowMetadata(script, file);
        const prior = names.get(meta.name);
        if (prior)
            throw new Error(
                `Workflow name collision "${meta.name}" at the same precedence level: ${prior} and ${file}.`,
            );
        names.set(meta.name, file);
        definitions.push({ ...meta, script, path: file, scope, ...(projectRoot ? { projectRoot } : {}) });
    }
    return definitions;
}

export async function discoverWorkflows(cwd: string, options: WorkflowStorageOptions = {}): Promise<SavedWorkflow[]> {
    const canonicalCwd = await fs.promises.realpath(cwd);
    const root = await (options.repositoryRoot ?? findRepositoryRoot)(canonicalCwd);
    const found = new Map<string, SavedWorkflow>();
    if (root) {
        const canonicalRoot = await fs.promises.realpath(root);
        if (path.relative(canonicalRoot, canonicalCwd).startsWith(".."))
            throw new Error("Canonical cwd is outside repository root.");
        for (let current = canonicalCwd; ; current = path.dirname(current)) {
            for (const workflow of await readLevel(
                path.join(current, ".pi", "workflows"),
                canonicalRoot,
                "project",
                canonicalRoot,
            ))
                if (!found.has(workflow.name)) found.set(workflow.name, workflow);
            if (current === canonicalRoot) break;
        }
    }
    const home = await fs.promises.realpath(options.home ?? os.homedir());
    for (const workflow of await readLevel(path.join(home, ".pi", "agent", "workflows"), home, "personal"))
        if (!found.has(workflow.name)) found.set(workflow.name, workflow);
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureSafeDirectory(directory: string, boundary: string, mode: number): Promise<void> {
    const relative = path.relative(boundary, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error(`Workflow destination escapes ${boundary}.`);
    let current = boundary;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            const stat = await fs.promises.lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe workflow directory: ${current}`);
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
            await fs.promises.mkdir(current, { mode });
        }
    }
}

export async function saveWorkflow(
    input: {
        cwd: string;
        name: string;
        script: string;
        scope: "project" | "personal";
        overwrite?: boolean;
    },
    options: WorkflowStorageOptions = {},
): Promise<string> {
    validateWorkflowName(input.name);
    if (Buffer.byteLength(input.script) > MAX_SAVED_WORKFLOW_BYTES)
        throw new Error("Workflow exceeds the 64 KiB limit.");
    const meta = parseWorkflowMetadata(input.script, "workflow being saved");
    if (meta.name !== input.name)
        throw new Error(`Workflow metadata name "${meta.name}" does not match "${input.name}".`);
    const base =
        input.scope === "personal"
            ? await fs.promises.realpath(options.home ?? os.homedir())
            : await fs.promises.realpath(input.cwd);
    const directory =
        input.scope === "personal" ? path.join(base, ".pi", "agent", "workflows") : path.join(base, ".pi", "workflows");
    await ensureSafeDirectory(directory, base, input.scope === "personal" ? 0o700 : 0o755);
    const destination = path.join(directory, `${input.name}.js`);
    try {
        const existing = await fs.promises.lstat(destination);
        if (existing.isSymbolicLink() || !existing.isFile())
            throw new Error(`Unsafe workflow destination: ${destination}`);
        if (!input.overwrite)
            throw new Error(`Workflow "${input.name}" already exists; confirm overwrite to replace it.`);
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }
    const temp = path.join(directory, `.${input.name}.${crypto.randomUUID()}.tmp`);
    try {
        await fs.promises.writeFile(temp, input.script, {
            flag: "wx",
            mode: input.scope === "personal" ? 0o600 : 0o644,
        });
        if (!input.overwrite) {
            try {
                await fs.promises.link(temp, destination);
            } catch (error: any) {
                if (error?.code === "EEXIST")
                    throw new Error(`Workflow "${input.name}" already exists; confirm overwrite to replace it.`);
                throw error;
            }
            await fs.promises.unlink(temp);
        } else await fs.promises.rename(temp, destination);
        return destination;
    } catch (error) {
        await fs.promises.rm(temp, { force: true });
        throw new Error(`Could not save workflow "${input.name}": ${message(error)}`);
    }
}
