import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface SystemBinary {
    command: string;
    source: "system";
}

type BinaryLookup = (name: string) => string | undefined;

/** Finds an executable on PATH without invoking a shell. */
export function findExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
    const path = environment.PATH;
    if (!path) return undefined;
    const extensions =
        process.platform === "win32" ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    for (const directory of path.split(delimiter)) {
        if (!directory) continue;
        for (const extension of extensions) {
            const candidate = join(directory, process.platform === "win32" ? `${name}${extension}` : name);
            try {
                accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
                if (statSync(candidate).isFile()) return candidate;
            } catch {
                // Keep searching PATH.
            }
        }
    }
    return undefined;
}

export function resolveFdBinary(lookup: BinaryLookup = findExecutable): SystemBinary {
    for (const name of ["fd", "fdfind"] as const) {
        const command = lookup(name);
        if (command) return { command, source: "system" };
    }
    throw new Error(
        "fd is not installed or is not on PATH. Install fd (the package may be named 'fd-find' and provide 'fdfind') and try again.",
    );
}

export function resolveRgBinary(lookup: BinaryLookup = findExecutable): SystemBinary {
    const command = lookup("rg");
    if (command) return { command, source: "system" };
    throw new Error("rg is not installed or is not on PATH. Install ripgrep and try again.");
}
