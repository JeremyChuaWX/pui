import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_WORKFLOW_SOURCE_BYTES = 64 * 1024;
export const WORKFLOW_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
        const character = literal[index];
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
    const declaration = declarations[0];
    if (!declaration || declaration.index === undefined) throw new Error(`${source}: invalid meta declaration.`);
    const start = declaration.index,
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
        if (!expression[1] || !expression[2]) throw new Error("Missing metadata strings.");
        name = parseStaticString(expression[1], source);
        description = parseStaticString(expression[2], source);
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
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export interface WorkflowFileSource {
    path: string;
    script: string;
    name: string;
    description?: string;
}

function filenameName(file: string): string {
    const value = path
        .basename(file, path.extname(file))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
        .replace(/-$/g, "");
    return value || "workflow";
}

/** Canonicalize and read a workflow file exactly once. */
export async function readWorkflowFile(cwd: string, requestedPath: string): Promise<WorkflowFileSource> {
    if (!requestedPath) throw new Error("Workflow path must not be empty.");
    const resolved = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath);
    const canonicalPath = await fs.promises.realpath(resolved);
    const handle = await fs.promises.open(canonicalPath, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Workflow path is not a regular file: ${canonicalPath}`);
        if (stat.size > MAX_WORKFLOW_SOURCE_BYTES)
            throw new Error(`${canonicalPath}: workflow exceeds the 64 KiB limit.`);
        const bytes = await handle.readFile();
        if (bytes.byteLength > MAX_WORKFLOW_SOURCE_BYTES)
            throw new Error(`${canonicalPath}: workflow exceeds the 64 KiB limit.`);
        let script: string;
        try {
            script = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            throw new Error(`${canonicalPath}: workflow source must be valid UTF-8.`);
        }
        const meta = /\bexport\s+const\s+meta\s*=/.test(script)
            ? parseWorkflowMetadata(script, canonicalPath)
            : undefined;
        return {
            path: canonicalPath,
            script,
            name: meta?.name ?? filenameName(canonicalPath),
            ...(meta ? { description: meta.description } : {}),
        };
    } finally {
        await handle.close();
    }
}
