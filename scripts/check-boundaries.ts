// Boundary check: asserts the one-way dependency edges between the top-level
// layers under src/ (app, ui, pi-core, modules/<name>, shared) and the
// Interfaces-Directory-only rule for Modules.
//
// Import spelling: an import is relative within a layer or Module and uses a
// "#<layer>/" package subpath alias (package.json "imports") across layers, so
// every cross-boundary edge is textually distinct from an intra-module one.
//
// Scope decisions:
// - Layer rules cover production code only. Test files (*.test.ts, *.test.tsx)
//   and files under a test-support/ directory are exempt as import sources: e.g.
//   pi-core/register.test.ts drives the UI controller, and module tests use
//   test-support/. Production code may not import either of them. The spelling
//   rule applies to test sources too.
// - Only relative and "#" specifiers are checked. Bare specifiers (npm packages,
//   the Pi SDK, node:/bun: builtins) and asset imports are out of scope.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ImportEdge {
    /** `src`-relative POSIX path of the importing file. */
    from: string;
    /** `src`-relative POSIX path of the imported file, or the raw "#" specifier when it did not resolve. */
    to: string;
    /** The specifier as written. Absent when the graph was built without specifiers; the spelling rule then does not apply. */
    specifier?: string;
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

// The App layer has no entry: it imports only Pi Core and the UI start function.
const INTERFACE_ENTRY_BY_LAYER: Record<string, string> = {
    ui: "ui",
    "pi-core": "pi",
};

/**
 * The unit an import must stay inside to be spelled relatively: a layer, or one Module. Unlike
 * `layerOf`, a Module-local test-support/ directory belongs to its Module here.
 */
function unitOf(filePath: string): string {
    const [top, second] = filePath.split("/");
    return top === "modules" && second ? `modules/${second}` : (top ?? "");
}

function judgeSpelling(edge: ImportEdge): string | undefined {
    if (edge.specifier === undefined) return undefined;
    if (edge.specifier.startsWith("#")) {
        if (edge.to.startsWith("#")) return `"${edge.specifier}" does not resolve through the package.json imports map`;
        if (unitOf(edge.from) === unitOf(edge.to)) {
            return "imports within a layer or Module must be relative, not aliased";
        }
        return undefined;
    }
    if (unitOf(edge.from) !== unitOf(edge.to)) {
        return `cross-layer imports must use the #${edge.to.split("/")[0]}/ alias, not a relative path`;
    }
    return undefined;
}

function judgeLayerRules(edge: ImportEdge): string | undefined {
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
        const testSource = isTestFile(edge.from) || isTestSupportFile(edge.from);
        const rule = judgeSpelling(edge) ?? (testSource ? undefined : judgeLayerRules(edge));
        if (rule !== undefined) violations.push({ ...edge, rule });
    }
    return violations;
}

const IMPORT_PATTERN =
    /\bfrom\s+["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)|\bimport\s+["']([^"'\n]+)["']/g;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveToTypeScript(base: string): string | undefined {
    const candidates = /\.js$/.test(base) ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")] : [];
    candidates.push(...RESOLUTION_SUFFIXES.map((suffix) => base + suffix));
    return candidates.find((candidate) => /\.tsx?$/.test(candidate) && fs.existsSync(candidate));
}

export interface ScanOptions {
    /** Directory containing package.json; "imports" targets are resolved against it. */
    packageRoot: string;
    /** The package.json "imports" map, e.g. `{ "#shared/*": "./src/shared/*" }`. */
    imports: Record<string, string>;
}

/** Expands a "#" specifier through the imports map; undefined when no pattern matches. */
function expandAlias(specifier: string, options: ScanOptions): string | undefined {
    for (const [pattern, target] of Object.entries(options.imports)) {
        const star = pattern.indexOf("*");
        if (star === -1) {
            if (specifier === pattern) return path.resolve(options.packageRoot, target);
            continue;
        }
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= pattern.length - 1) {
            const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
            return path.resolve(options.packageRoot, target.replace("*", wildcard));
        }
    }
    return undefined;
}

/**
 * Imperative shell: scan every directory under `sourceRoot` (the repo's `src/`) and build the import
 * graph. Edge paths are relative to `sourceRoot`, so layers appear as the first path segment.
 * Relative specifiers resolve from the importing file; "#" specifiers resolve through the imports
 * map and are kept verbatim as `to` when no map entry matches. Imports of non-TypeScript files
 * (bundled assets) are out of scope whichever way they are spelled.
 */
export function collectImportEdges(sourceRoot: string, options: ScanOptions): ImportEdge[] {
    const edges: ImportEdge[] = [];
    const toSourceRelative = (absolute: string) => path.relative(sourceRoot, absolute).split(path.sep).join("/");
    const files = fs
        .readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
        .map((entry) => path.join(sourceRoot, entry))
        .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
        .sort();
    for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(IMPORT_PATTERN)) {
            const specifier = match[1] ?? match[2] ?? match[3];
            if (specifier === undefined) continue;
            const from = toSourceRelative(file);
            if (specifier.startsWith("#")) {
                const expanded = expandAlias(specifier, options);
                if (expanded === undefined) {
                    edges.push({ from, to: specifier, specifier });
                    continue;
                }
                const resolved = resolveToTypeScript(expanded);
                if (resolved !== undefined) edges.push({ from, to: toSourceRelative(resolved), specifier });
            } else if (specifier.startsWith(".")) {
                const resolved = resolveToTypeScript(path.resolve(path.dirname(file), specifier));
                if (resolved !== undefined) edges.push({ from, to: toSourceRelative(resolved), specifier });
            } // bare specifiers are out of scope
        }
    }
    return edges;
}

if (import.meta.main) {
    const packageRoot = path.resolve(import.meta.dir, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
        imports?: Record<string, string>;
    };
    const violations = checkBoundaries(
        collectImportEdges(path.join(packageRoot, "src"), { packageRoot, imports: manifest.imports ?? {} }),
    );
    if (violations.length > 0) {
        console.error(`Boundary check failed with ${violations.length} violation(s):`);
        for (const violation of violations) {
            console.error(`  ${violation.from} -> ${violation.to}: ${violation.rule}`);
        }
        process.exit(1);
    }
    console.log("Boundary check passed.");
}
