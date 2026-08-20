import { maskLiterals } from "./js-scan.js";
import type { WorkflowEntrypoint } from "./protocol.js";
import { executableWorkflowScript } from "./source.js";

const MAX_SCRIPT_BYTES = 64 * 1024;

function eraseTypeOnlyNamespaces(source: string): string {
    const code = maskLiterals(source, { preserveTemplateInterpolations: true }),
        output = [...source];
    for (const match of code.matchAll(/\bnamespace\s+[A-Za-z_$][\w$]*\s*\{/g)) {
        const start = match.index,
            open = start + match[0].lastIndexOf("{");
        let depth = 1,
            end = open + 1;
        while (end < code.length && depth) {
            if (code[end] === "{") depth++;
            else if (code[end] === "}") depth--;
            end++;
        }
        if (depth || new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)).trim())
            throw new Error("Workflow script uses TypeScript syntax unsupported in strip-only mode.");
        for (let index = start; index < end; index++)
            if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
    return output.join("");
}

export function preflightWorkflow(
    script: string,
    entrypoint: WorkflowEntrypoint = "script",
): { phases: string[]; agents: number; shells: number } {
    if (!script.trim()) throw new Error("Workflow script must not be empty.");
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error("Workflow script exceeds the 64 KiB limit.");
    if (entrypoint !== "script" && entrypoint !== "function") throw new Error("Invalid workflow entrypoint.");
    const executable = executableWorkflowScript(script, entrypoint),
        erasableExecutable = eraseTypeOnlyNamespaces(executable);
    // Node executes workflows with strip-only type erasure, so reject syntax Bun would otherwise transform.
    const sourceCode = maskLiterals(executable, { preserveTemplateInterpolations: true });
    if (
        /\benum\s+[A-Za-z_$]/.test(sourceCode) ||
        /\bmodule\s+[A-Za-z_$]/.test(sourceCode) ||
        /@[A-Za-z_$]/.test(sourceCode) ||
        /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?[#A-Za-z_$]/.test(sourceCode)
    )
        throw new Error("Workflow script uses TypeScript syntax unsupported in strip-only mode.");
    // Defense in depth only: process isolation, Node permissions, a stripped realm, and host validation
    // remain authoritative. Reject obvious and obfuscated ambient-authority probes before approval.
    const forbidden =
        /(?:\b(?:process|require|eval|Function|WebSocket|fetch|XMLHttpRequest|Deno|Bun|child_process)\b|\bimport\b|\bexport\s|__proto__)/;
    // Match the worker's type erasure before scanning; Bun hosts cannot import Node's stripTypeScriptTypes.
    const code = maskLiterals(
        new Bun.Transpiler({ loader: "ts" }).transformSync(`(async()=>{${erasableExecutable}\n})()`),
        {
            preserveTemplateInterpolations: true,
        },
    );
    if (forbidden.test(code)) throw new Error("Workflow script uses a forbidden runtime capability.");
    return {
        phases: [...executable.matchAll(/\bphase\s*\(\s*(["'`])([^"'`]{1,512})\1/g)]
            .map((m) => m[2] ?? "")
            .slice(0, 100),
        agents: [...executable.matchAll(/\bagent\s*\(/g)].length,
        shells: [...executable.matchAll(/\bshell\s*\(/g)].length,
    };
}
