// Boundary check: asserts the one-way dependency edges between the top-level
// layers (app, ui, pi-core, modules/<name>, shared) and the
// Interfaces-Directory-only rule for Modules.
//
// Scope decisions:
// - Rules cover production code only. Test files (*.test.ts, *.test.tsx) and
//   files under a test-support/ directory are exempt as import sources: e.g.
//   pi-core/register.test.ts drives the UI controller, and module tests use
//   extensions/test-support. Production code may not import either of them.
// - Only imports that resolve to TypeScript files inside the repo are checked.
//   Bare specifiers (npm packages, the Pi SDK, node:/bun: builtins) and asset
//   imports are out of scope.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ImportEdge {
    /** Repo-relative POSIX path of the importing file. */
    from: string;
    /** Repo-relative POSIX path of the imported file. */
    to: string;
}

export interface Violation extends ImportEdge {
    rule: string;
}

type Layer =
    | { kind: "app" | "ui" | "pi-core" | "shared" | "test-support" | "unknown" }
    | { kind: "module"; name: string };

function layerOf(filePath: string): Layer {
    if (isTestSupportFile(filePath)) return { kind: "test-support" };
    const [top, second] = filePath.split("/");
    if (top === "app" || top === "ui" || top === "pi-core" || top === "shared") return { kind: top };
    if (top === "modules" && second) return { kind: "module", name: second };
    return { kind: "unknown" };
}

function isTestFile(filePath: string): boolean {
    return /\.test\.tsx?$/.test(filePath);
}

function isTestSupportFile(filePath: string): boolean {
    return filePath.split("/").includes("test-support");
}

/** Matches modules/<name>/interfaces/<entry>.ts(x) and returns the entry name. */
function moduleInterfaceEntry(filePath: string): string | undefined {
    const match = filePath.match(/^modules\/[^/]+\/interfaces\/([^/.]+)\.tsx?$/);
    return match?.[1];
}

const INTERFACE_ENTRY_BY_LAYER: Record<string, string> = {
    app: "host",
    ui: "ui",
    "pi-core": "pi",
};

function judge(edge: ImportEdge): string | undefined {
    const from = layerOf(edge.from);
    const to = layerOf(edge.to);

    if (to.kind === "test-support") return "production code must not import test support";
    if (isTestFile(edge.to)) return "production code must not import test files";
    if (to.kind === "unknown") return "import resolves outside the known layers (app, ui, pi-core, modules, shared)";
    if (to.kind === "shared") return undefined;
    if (from.kind === to.kind && (from.kind !== "module" || (to.kind === "module" && from.name === to.name))) {
        return undefined; // same layer / same Module
    }

    if (to.kind === "module") {
        if (from.kind === "module") return "Modules must not import other Modules";
        const entry = moduleInterfaceEntry(edge.to);
        if (entry === undefined) return "Module internals are private; import the Module's Interfaces Directory";
        const allowed = INTERFACE_ENTRY_BY_LAYER[from.kind];
        if (allowed === undefined) return `${from.kind} must not import Modules`;
        if (entry !== allowed) {
            return `${from.kind} may only import a Module's interfaces/${allowed}, not interfaces/${entry}`;
        }
        return undefined;
    }
    if (to.kind === "app") return "nothing may import the app layer";
    if (to.kind === "ui") {
        if (from.kind === "app") {
            return /^ui\/start\.tsx?$/.test(edge.to)
                ? undefined
                : "app may only import the UI start function (ui/start)";
        }
        return "only the app layer may import the UI, and only via ui/start";
    }
    // to.kind === "pi-core"
    if (from.kind === "app" || from.kind === "ui") return undefined;
    return `${from.kind} must not import pi-core`;
}

/** Pure rule function: import graph in, violation list out. */
export function checkBoundaries(edges: ImportEdge[]): Violation[] {
    const violations: Violation[] = [];
    for (const edge of edges) {
        if (isTestFile(edge.from) || isTestSupportFile(edge.from)) continue;
        const rule = judge(edge);
        if (rule !== undefined) violations.push({ ...edge, rule });
    }
    return violations;
}

const SOURCE_DIRECTORIES = ["app", "ui", "pi-core", "modules", "shared", "extensions"];
const IMPORT_PATTERN =
    /\bfrom\s+["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)|\bimport\s+["']([^"'\n]+)["']/g;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = /\.js$/.test(base) ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")] : [];
    candidates.push(...RESOLUTION_SUFFIXES.map((suffix) => base + suffix));
    return candidates.find((candidate) => /\.tsx?$/.test(candidate) && fs.existsSync(candidate));
}

/** Imperative shell: scan the layer directories and build the import graph. */
export function collectImportEdges(rootDir: string): ImportEdge[] {
    const edges: ImportEdge[] = [];
    const toRepoRelative = (absolute: string) => path.relative(rootDir, absolute).split(path.sep).join("/");
    for (const directory of SOURCE_DIRECTORIES) {
        const files = fs
            .readdirSync(path.join(rootDir, directory), { recursive: true, encoding: "utf8" })
            .map((entry) => path.join(rootDir, directory, entry))
            .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"));
        for (const file of files) {
            const source = fs.readFileSync(file, "utf8");
            for (const match of source.matchAll(IMPORT_PATTERN)) {
                const specifier = match[1] ?? match[2] ?? match[3];
                if (specifier === undefined || !specifier.startsWith(".")) continue; // bare specifiers are out of scope
                const resolved = resolveRelativeImport(file, specifier);
                if (resolved !== undefined) edges.push({ from: toRepoRelative(file), to: toRepoRelative(resolved) });
            }
        }
    }
    return edges;
}

if (import.meta.main) {
    const violations = checkBoundaries(collectImportEdges(path.resolve(import.meta.dir, "..")));
    if (violations.length > 0) {
        console.error(`Boundary check failed with ${violations.length} violation(s):`);
        for (const violation of violations) {
            console.error(`  ${violation.from} -> ${violation.to}: ${violation.rule}`);
        }
        process.exit(1);
    }
    console.log("Boundary check passed.");
}
