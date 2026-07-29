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

function regexLiteralStartsAt(
    script: string,
    index: number,
    previousWord: string | undefined,
    followsStatement: boolean,
): boolean {
    const prefix = script.slice(0, index).trimEnd();
    if (!prefix || followsStatement) return true;
    const previous = prefix.at(-1);
    if (previous && "([{=,:;!?&|+-*%^~<>".includes(previous)) return true;
    return (
        previousWord !== undefined &&
        /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/.test(previousWord)
    );
}

function metadataDeclarations(script: string): RegExpExecArray[] {
    const declarations: RegExpExecArray[] = [];
    const declarationPattern = /\bexport\s+const\s+meta\s*=/y;
    const controlParens: boolean[] = [];
    const blockBraces: boolean[] = [];
    let depth = 0;
    let previousWord: string | undefined;
    let followsControlCondition = false;
    for (let index = 0; index < script.length; index++) {
        const character = script[index];
        const next = script[index + 1];
        if (depth === 0) {
            declarationPattern.lastIndex = index;
            const declaration = declarationPattern.exec(script);
            if (declaration) {
                declarations.push(declaration);
                index = declarationPattern.lastIndex - 1;
                previousWord = undefined;
                followsControlCondition = false;
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
            const quote = character;
            for (index++; index < script.length; index++) {
                if (script[index] === "\\") index++;
                else if (script[index] === quote) break;
            }
            previousWord = undefined;
            followsControlCondition = false;
        } else if (character === "/" && regexLiteralStartsAt(script, index, previousWord, followsControlCondition)) {
            let characterClass = false;
            for (index++; index < script.length; index++) {
                if (script[index] === "\\") index++;
                else if (script[index] === "[") characterClass = true;
                else if (script[index] === "]") characterClass = false;
                else if (script[index] === "/" && !characterClass) break;
            }
            while (/[a-z]/i.test(script[index + 1] ?? "")) index++;
            previousWord = undefined;
            followsControlCondition = false;
        } else if (/[A-Za-z_$]/.test(character)) {
            const end = /^[\w$]*/.exec(script.slice(index + 1))?.[0].length ?? 0;
            previousWord = script.slice(index, index + end + 1);
            followsControlCondition = false;
            index += end;
        } else if (character === "(") {
            controlParens.push(/^(?:catch|for|if|switch|while|with)$/.test(previousWord ?? ""));
            depth++;
            previousWord = undefined;
            followsControlCondition = false;
        } else if (character === "{") {
            blockBraces.push(
                followsControlCondition ||
                    /^(?:do|else|finally|try)$/.test(previousWord ?? "") ||
                    !script.slice(0, index).trim(),
            );
            depth++;
            previousWord = undefined;
            followsControlCondition = false;
        } else if (character === "[") {
            depth++;
            previousWord = undefined;
            followsControlCondition = false;
        } else if (character === ")") {
            depth = Math.max(0, depth - 1);
            followsControlCondition = controlParens.pop() ?? false;
            previousWord = undefined;
        } else if (character === "}") {
            depth = Math.max(0, depth - 1);
            previousWord = undefined;
            followsControlCondition = blockBraces.pop() ?? false;
        } else if (character === "]") {
            depth = Math.max(0, depth - 1);
            previousWord = undefined;
            followsControlCondition = false;
        } else if (!/\s/.test(character)) {
            previousWord = undefined;
            followsControlCondition = false;
        }
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
        String.raw`^export\s+const\s+meta\s*=\s*\{\s*name\s*:\s*${JS_STRING}\s*,\s*description\s*:\s*${JS_STRING}\s*,?\s*\}\s*;?`,
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

export function executableWorkflowScript(script: string): string {
    if (!hasWorkflowMetadata(script)) return script;
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
            script = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            throw new Error(`${canonicalPath}: workflow source must be valid UTF-8.`);
        }
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
