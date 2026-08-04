import * as fs from "node:fs";
import * as path from "node:path";
import { CodeScanState, maskLiterals, regexLiteralStartsAt, skipRegexLiteral, skipStringLiteral } from "./js-scan.js";

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
    if (literal.startsWith('"')) {
        try {
            return JSON.parse(literal);
        } catch {
            throw new Error(`${source}: meta contains an invalid escaped string literal.`);
        }
    }
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

function metadataDeclarations(script: string): RegExpExecArray[] {
    const declarations: RegExpExecArray[] = [];
    const declarationPattern = /\bexport\s+const\s+meta\s*=/y;
    const state = new CodeScanState();
    for (let index = 0; index < script.length; index++) {
        const character = script[index];
        const next = script[index + 1];
        if (state.depth === 0) {
            declarationPattern.lastIndex = index;
            const declaration = declarationPattern.exec(script);
            if (declaration) {
                declarations.push(declaration);
                index = declarationPattern.lastIndex - 1;
                state.resetWord();
                continue;
            }
        }
        if (character === "/" && next === "/") {
            index = script.indexOf("\n", index + 2);
            if (index === -1) break;
        } else if (character === "/" && next === "*") {
            const end = script.indexOf("*/", index + 2);
            if (end === -1) break;
            index = end + 1;
        } else if (character === '"' || character === "'" || character === "`") {
            index = skipStringLiteral(script, index);
            state.resetWord();
        } else if (
            character === "/" &&
            regexLiteralStartsAt(script, index, state.previousWord, state.followsControlCondition)
        ) {
            index = skipRegexLiteral(script, index);
            state.resetWord();
        } else index = state.step(script, index);
    }
    return declarations;
}

export function hasWorkflowMetadata(script: string): boolean {
    return metadataDeclarations(script).length > 0;
}

/** Parse static metadata without importing or evaluating workflow code. */
export function parseWorkflowMetadata(script: string, source = "workflow"): WorkflowMetadata {
    const declarations = metadataDeclarations(script);
    if (declarations.length !== 1)
        throw new Error(`${source}: expected exactly one static export const meta declaration.`);
    const declaration = declarations[0];
    if (!declaration || declaration.index === undefined) throw new Error(`${source}: invalid meta declaration.`);
    const start = declaration.index,
        tail = script.slice(start);
    const expression = new RegExp(
        String.raw`^export\s+const\s+meta\s*=\s*\{\s*name\s*:\s*${JS_STRING}\s*,\s*description\s*:\s*${JS_STRING}\s*,?\s*\}(?:\s+satisfies\s+WorkflowMetadata)?\s*;?`,
    ).exec(tail);
    if (!expression)
        throw new Error(
            `${source}: meta must be a static { name: "...", description: "..." } object using JSON string literals.`,
        );
    if (!expression[1] || !expression[2]) throw new Error(`${source}: meta is missing metadata strings.`);
    const name = parseStaticString(expression[1], source);
    const description = parseStaticString(expression[2], source);
    validateWorkflowName(name);
    if (!description.trim() || description.length > 512)
        throw new Error(`${source}: meta.description must contain 1-512 characters.`);
    return { name, description, declarationStart: start, declarationEnd: start + expression[0].length };
}

export interface WorkflowEntrypoint {
    name: string;
    declarationStart: number;
    exportEnd: number;
    typeImports: { start: number; end: number }[];
}

function topLevel(code: string, offset: number): boolean {
    let depth = 0;
    for (let index = 0; index < offset; index++) {
        if (code[index] === "{" || code[index] === "(" || code[index] === "[") depth++;
        else if (code[index] === "}" || code[index] === ")" || code[index] === "]") depth--;
    }
    return depth === 0;
}

function workflowTypeImports(script: string, code: string): { start: number; end: number }[] {
    const imports: { start: number; end: number }[] = [];
    const pattern = /\bimport\s+type\s*\{[^{}]*\}\s+from\s*(["'])pui\/workflow\1\s*;?/g;
    for (const match of script.matchAll(pattern))
        if (match.index !== undefined && code.slice(match.index).startsWith("import") && topLevel(code, match.index))
            imports.push({ start: match.index, end: match.index + match[0].length });
    return imports;
}

/** Find and validate the sole default-exported workflow function without evaluating the file. */
export function parseWorkflowEntrypoint(script: string, source = "workflow"): WorkflowEntrypoint {
    const code = maskLiterals(script);
    const exports = [...code.matchAll(/\bexport\b/g)].filter((match) => topLevel(code, match.index ?? 0));
    const entries = [...code.matchAll(/\bexport\s+default\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].filter(
        (match) => exports.some((candidate) => candidate.index === match.index),
    );
    if (entries.length !== 1)
        throw new Error(`${source}: expected exactly one default-exported async function entrypoint.`);
    const entry = entries[0];
    if (!entry || entry.index === undefined || !entry[1]) throw new Error(`${source}: invalid workflow entrypoint.`);
    const allowedMeta = metadataDeclarations(script);
    if (exports.some((item) => item.index !== entry.index && !allowedMeta.some((meta) => meta.index === item.index)))
        throw new Error(
            `${source}: only the default async workflow function and optional export const meta may be exported.`,
        );
    const typeImports = workflowTypeImports(script, code);
    if (
        [...code.matchAll(/\bimport\b/g)].some(
            (item) => item.index === undefined || !typeImports.some(({ start }) => start === item.index),
        )
    )
        throw new Error(`${source}: only import type { ... } from "pui/workflow" is allowed.`);
    const exportText = /export\s+default\s+/.exec(code.slice(entry.index));
    if (!exportText) throw new Error(`${source}: invalid workflow entrypoint export.`);
    return {
        name: entry[1],
        declarationStart: entry.index,
        exportEnd: entry.index + exportText[0].length,
        typeImports,
    };
}

/** Convert approved file source to an invocation, or leave a legacy inline body executable. */
export function executableWorkflowScript(script: string, kind: "script" | "function" = "script"): string {
    if (kind === "script") {
        if (!hasWorkflowMetadata(script)) return script;
        const meta = parseWorkflowMetadata(script);
        return script.slice(0, meta.declarationStart) + script.slice(meta.declarationEnd);
    }
    const entry = parseWorkflowEntrypoint(script);
    const meta = hasWorkflowMetadata(script) ? parseWorkflowMetadata(script) : undefined;
    const removals = [
        [entry.declarationStart, entry.exportEnd],
        ...entry.typeImports.map(({ start, end }) => [start, end]),
        ...(meta ? [[meta.declarationStart, meta.declarationEnd]] : []),
    ].sort((a, b) => b[0] - a[0]);
    let executable = script;
    for (const [start, end] of removals) executable = executable.slice(0, start) + executable.slice(end);
    return `${executable}\nreturn await ${entry.name}(__puiWorkflowContext, __puiWorkflowArgs);`;
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
    let handle: fs.promises.FileHandle | undefined;
    let canonicalPath = resolved;
    let stat: fs.Stats | undefined;
    // Opening first, then matching device/inode closes the realpath-to-open race while still following symlinks.
    for (let attempt = 0; attempt < 3; attempt++) {
        handle = await fs.promises.open(resolved, "r");
        try {
            stat = await handle.stat();
            canonicalPath = await fs.promises.realpath(resolved);
            const pathStat = await fs.promises.stat(canonicalPath);
            if (stat.dev === pathStat.dev && stat.ino === pathStat.ino) break;
        } catch (error) {
            await handle.close();
            handle = undefined;
            if (attempt === 2) throw error;
            continue;
        }
        await handle.close();
        handle = undefined;
    }
    if (!handle || !stat) throw new Error(`Workflow path changed while opening: ${resolved}`);
    try {
        if (!stat.isFile()) throw new Error(`Workflow path is not a regular file: ${canonicalPath}`);
        if (path.extname(canonicalPath) !== ".ts")
            throw new Error(`${canonicalPath}: workflow files must use the .ts extension (rename this file to .ts).`);
        if (stat.size > MAX_WORKFLOW_SOURCE_BYTES)
            throw new Error(`${canonicalPath}: workflow exceeds the 64 KiB limit.`);
        const buffer = Buffer.allocUnsafe(MAX_WORKFLOW_SOURCE_BYTES + 1);
        let byteLength = 0;
        while (byteLength < buffer.byteLength) {
            const { bytesRead } = await handle.read(buffer, byteLength, buffer.byteLength - byteLength, null);
            if (bytesRead === 0) break;
            byteLength += bytesRead;
        }
        if (byteLength > MAX_WORKFLOW_SOURCE_BYTES)
            throw new Error(`${canonicalPath}: workflow exceeds the 64 KiB limit.`);
        const bytes = buffer.subarray(0, byteLength);
        let script: string;
        try {
            script = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
            throw new Error(`${canonicalPath}: workflow source must be valid UTF-8.`);
        }
        parseWorkflowEntrypoint(script, canonicalPath);
        const meta = hasWorkflowMetadata(script) ? parseWorkflowMetadata(script, canonicalPath) : undefined;
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
