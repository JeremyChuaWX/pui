import * as fs from "node:fs";
import * as path from "node:path";

function contained(boundary: string, target: string) {
    const relative = path.relative(boundary, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Finds a trusted existing directory above target without trusting a symlink at the target's parent. */
export async function inferDirectoryBoundary(target: string): Promise<string> {
    let candidate = path.dirname(path.resolve(target));
    for (;;) {
        const stat = await fs.promises.lstat(candidate).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) return candidate;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw new Error(`No safe directory boundary for ${target}.`);
        candidate = parent;
    }
}

/** Walks and optionally creates target one component at a time beneath a canonical trusted boundary. */
export async function safeDirectory(target: string, trustedBoundary: string, create: boolean): Promise<string> {
    const boundaryPath = path.resolve(trustedBoundary),
        targetPath = path.resolve(target),
        relative = path.relative(boundaryPath, targetPath);
    if (!contained(boundaryPath, targetPath)) throw new Error("Directory escapes its trusted boundary.");
    const boundary = await fs.promises.realpath(boundaryPath),
        boundaryStat = await fs.promises.stat(boundary);
    if (!boundaryStat.isDirectory()) throw new Error("Trusted boundary is not a directory.");
    let current = boundary;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let stat = await fs.promises.lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
        });
        if (!stat && create) {
            await fs.promises.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error;
            });
            stat = await fs.promises.lstat(current);
        }
        if (!stat) throw Object.assign(new Error(`Directory does not exist: ${current}`), { code: "ENOENT" });
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory component: ${current}`);
        const canonical = await fs.promises.realpath(current);
        if (!contained(boundary, canonical)) throw new Error("Directory escapes its canonical trusted boundary.");
        current = canonical;
    }
    return current;
}
