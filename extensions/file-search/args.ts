import { homedir } from "node:os";

export type FdFileType = "file" | "directory" | "symlink";

export interface FdArgs {
    pattern?: string;
    path?: string;
    type?: FdFileType;
    extension?: string;
    glob?: boolean;
    hidden?: boolean;
    max_depth?: number;
    limit?: number;
}

export interface RgArgs {
    pattern: string;
    path?: string;
    glob?: string;
    file_type?: string;
    case_sensitive?: boolean;
    fixed_strings?: boolean;
    hidden?: boolean;
    context?: number;
    limit?: number;
}

function boundedInteger(name: string, value: number | undefined, fallback: number, minimum: number, maximum: number) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
        throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return resolved;
}

/** Normalizes model-produced path arguments without resolving them against a cwd. */
export function normalizeSearchPath(value: string, home = homedir()): string {
    const path = value.startsWith("@") ? value.slice(1) : value;
    if (path === "~") return home;
    if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
    return path;
}

/** Builds fd arguments. The caller must execute fd directly, without a shell. */
export function buildFdArgs(input: FdArgs = {}, home = homedir()): string[] {
    const args = ["--color=never", "--max-results", String(boundedInteger("limit", input.limit, 1000, 1, 10_000))];
    if (input.type) args.push("--type", input.type);
    if (input.extension !== undefined) args.push("--extension", input.extension.replace(/^\.+/, ""));
    if (input.glob) args.push("--glob");
    if (input.hidden) args.push("--hidden");
    if (input.max_depth !== undefined) {
        args.push("--max-depth", String(boundedInteger("max_depth", input.max_depth, input.max_depth, 1, 64)));
    }
    args.push("--", input.pattern ?? "");
    if (input.path !== undefined) args.push(normalizeSearchPath(input.path, home));
    return args;
}

/** Builds rg arguments. The caller must execute rg directly, without a shell. */
export function buildRgArgs(input: RgArgs, home = homedir()): string[] {
    const args = [
        "--line-number",
        "--color=never",
        "--no-heading",
        "--with-filename",
        input.case_sensitive === undefined
            ? "--smart-case"
            : input.case_sensitive
              ? "--case-sensitive"
              : "--ignore-case",
        "--max-count",
        String(boundedInteger("limit", input.limit, 100, 1, 1000)),
    ];
    if (input.glob !== undefined) args.push("--glob", input.glob);
    if (input.file_type !== undefined) args.push("--type", input.file_type);
    if (input.fixed_strings) args.push("--fixed-strings");
    if (input.hidden) args.push("--hidden");
    if (input.context !== undefined) {
        args.push("--context", String(boundedInteger("context", input.context, input.context, 0, 20)));
    }
    args.push("--", input.pattern);
    if (input.path !== undefined) args.push(normalizeSearchPath(input.path, home));
    return args;
}
