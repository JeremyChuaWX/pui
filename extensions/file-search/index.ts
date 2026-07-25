import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildFdArgs, buildRgArgs, type FdArgs, type RgArgs } from "./args.js";
import { resolveFdBinary, resolveRgBinary, type SystemBinary } from "./binaries.js";
import { type FileSearchProcessResult, type RunFileSearchOptions, runFileSearch } from "./process.js";

export interface FileSearchDetails {
    binarySource: "system" | "managed";
    count: number;
    truncated: boolean;
    fullOutputPath?: string;
}

export interface FileSearchExtensionDependencies {
    resolveFd?: () => SystemBinary;
    resolveRg?: () => SystemBinary;
    run?: (options: RunFileSearchOptions) => Promise<FileSearchProcessResult>;
}

const FdParams = Type.Object({
    pattern: Type.Optional(Type.String({ description: "Regex matched against file names; a glob when glob is true." })),
    path: Type.Optional(
        Type.String({ description: "Directory to search; defaults to the session working directory." }),
    ),
    type: Type.Optional(StringEnum(["file", "directory", "symlink"] as const)),
    extension: Type.Optional(Type.String({ description: "File extension, with or without a leading dot." })),
    glob: Type.Optional(Type.Boolean()),
    hidden: Type.Optional(Type.Boolean()),
    max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, default: 1000 })),
});

const RgParams = Type.Object({
    pattern: Type.String({ description: "Regex (or literal text when fixed_strings is true) to search for." }),
    path: Type.Optional(
        Type.String({ description: "File or directory to search; defaults to the session working directory." }),
    ),
    glob: Type.Optional(Type.String()),
    file_type: Type.Optional(Type.String()),
    case_sensitive: Type.Optional(Type.Boolean({ description: "Omit for smart-case matching." })),
    fixed_strings: Type.Optional(Type.Boolean({ description: "Treat pattern literally instead of as a regex." })),
    hidden: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
});

function result(binary: SystemBinary, execution: FileSearchProcessResult) {
    if (execution.status !== "succeeded") {
        const reason = execution.stderr.trim() || `process exited with code ${execution.exitCode ?? "unknown"}`;
        const diagnostic = truncateHead(reason, { maxBytes: 8 * 1024, maxLines: 200 }).content;
        const fullOutput = execution.fullOutputPath ? ` Full output: ${execution.fullOutputPath}` : "";
        if (execution.status === "cancelled") throw new Error(`File search was cancelled.${fullOutput}`);
        if (execution.status === "timed_out")
            throw new Error(
                `File search timed out after 60 seconds; narrow the path or pattern and try again.${fullOutput}`,
            );
        throw new Error(`File search failed: ${diagnostic}${fullOutput}`);
    }
    let text = execution.output || "No matches found.";
    if (execution.truncated) {
        const notice = `\n\n[Output truncated. Complete output: ${execution.fullOutputPath}]`;
        const visible = truncateHead(text, {
            maxBytes: Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8")),
            maxLines: DEFAULT_MAX_LINES - 2,
        });
        text = `${visible.content}${notice}`;
    }
    return {
        content: [{ type: "text" as const, text }],
        details: {
            binarySource: binary.source,
            count: execution.count,
            truncated: execution.truncated,
            ...(execution.fullOutputPath && { fullOutputPath: execution.fullOutputPath }),
        } satisfies FileSearchDetails,
    };
}

/** Registers direct, shell-free fd and ripgrep tools. */
export function registerFileSearchExtension(
    pi: ExtensionAPI,
    dependencies: FileSearchExtensionDependencies = {},
): void {
    const run = dependencies.run ?? runFileSearch;
    const retainedOutputCleanups = new Set<() => Promise<void>>();
    let fdBinary: SystemBinary | undefined;
    let rgBinary: SystemBinary | undefined;
    let shuttingDown = false;
    const retainOutput = async (execution: FileSearchProcessResult) => {
        if (!execution.cleanup) return;
        if (!shuttingDown) {
            retainedOutputCleanups.add(execution.cleanup);
            return;
        }
        await execution.cleanup().catch(() => {});
    };

    pi.on("session_shutdown", async () => {
        shuttingDown = true;
        const cleanups = [...retainedOutputCleanups];
        retainedOutputCleanups.clear();
        await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    });

    pi.registerTool({
        name: "fd",
        label: "Find files",
        description: "Discover files and directories by name, extension, or glob using fd.",
        promptSnippet: "Discover files by name, extension, type, or glob with fd",
        promptGuidelines: ["Prefer fd for discovering files by name, extension, or glob."],
        parameters: FdParams,
        async execute(_id, params, signal, _onUpdate, ctx) {
            if (!fdBinary) fdBinary = (dependencies.resolveFd ?? resolveFdBinary)();
            const execution = await run({
                command: fdBinary.command,
                args: buildFdArgs(params as FdArgs),
                tool: "fd",
                cwd: ctx.cwd,
                signal,
            });
            await retainOutput(execution);
            return result(fdBinary, execution);
        },
    });
    pi.registerTool({
        name: "rg",
        label: "Search file contents",
        description:
            "Search file contents using ripgrep. Use fixed_strings for literal code containing regex metacharacters.",
        promptSnippet: "Search file contents with rg",
        promptGuidelines: [
            "Prefer rg for searching file contents.",
            "Use rg's fixed_strings option for literal code containing regex metacharacters.",
            "Continue using bash for complex search pipelines and post-processing.",
        ],
        parameters: RgParams,
        async execute(_id, params, signal, _onUpdate, ctx) {
            if (!rgBinary) rgBinary = (dependencies.resolveRg ?? resolveRgBinary)();
            const execution = await run({
                command: rgBinary.command,
                args: buildRgArgs(params as RgArgs),
                tool: "rg",
                cwd: ctx.cwd,
                signal,
            });
            await retainOutput(execution);
            return result(rgBinary, execution);
        },
    });
}

export default registerFileSearchExtension;
