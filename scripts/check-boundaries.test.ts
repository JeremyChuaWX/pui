import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkBoundaries, collectImportEdges, type ImportEdge } from "./check-boundaries.ts";

function violationsFor(edges: ImportEdge[]) {
    return checkBoundaries(edges).map((violation) => `${violation.from} -> ${violation.to}`);
}

describe("clean graph", () => {
    test("every sanctioned edge produces no violations", () => {
        const edges: ImportEdge[] = [
            // App -> UI start function + shared
            { from: "app/index.tsx", to: "ui/start.tsx" },
            { from: "app/index.tsx", to: "shared/lib/validate.ts" },
            // UI -> Pi Core + Module UI Entries + shared + itself
            { from: "ui/state/controller.ts", to: "pi-core/register.ts" },
            { from: "ui/state/format.ts", to: "modules/subagents/interfaces/ui.ts" },
            { from: "ui/state/prompt-autocomplete.ts", to: "modules/file-search/interfaces/ui.ts" },
            { from: "ui/components/app.tsx", to: "ui/state/controller.ts" },
            { from: "ui/state/controller.ts", to: "shared/lib/validate.ts" },
            // Pi Core -> Module Extensions + shared + itself
            { from: "pi-core/register.ts", to: "modules/web/interfaces/pi.ts" },
            { from: "pi-core/register.ts", to: "pi-core/bundled-skills.ts" },
            { from: "pi-core/register.ts", to: "shared/lib/validate.ts" },
            // Modules -> own internals + shared
            { from: "modules/web/search.ts", to: "modules/web/crawl.ts" },
            { from: "modules/web/interfaces/pi.ts", to: "modules/web/search.ts" },
            { from: "modules/subagents/runner.ts", to: "shared/agent-runtime/child-agent.ts" },
            // shared -> shared
            { from: "shared/agent-runtime/child-agent.ts", to: "shared/lib/json-events.ts" },
        ];
        expect(checkBoundaries(edges)).toEqual([]);
    });
});

describe("forbidden edges", () => {
    test("Module -> Module is a violation even through an Interfaces Directory", () => {
        const edges: ImportEdge[] = [{ from: "modules/web/search.ts", to: "modules/subagents/interfaces/pi.ts" }];
        expect(violationsFor(edges)).toEqual(["modules/web/search.ts -> modules/subagents/interfaces/pi.ts"]);
    });

    test("deep import bypassing an Interfaces Directory is a violation", () => {
        const edges: ImportEdge[] = [{ from: "ui/components/app.tsx", to: "modules/subagents/view-model.ts" }];
        expect(violationsFor(edges)).toEqual(["ui/components/app.tsx -> modules/subagents/view-model.ts"]);
    });

    test("UI -> App is a violation", () => {
        const edges: ImportEdge[] = [{ from: "ui/state/controller.ts", to: "app/index.tsx" }];
        expect(violationsFor(edges)).toEqual(["ui/state/controller.ts -> app/index.tsx"]);
    });

    test("Pi Core -> Host Entry is a violation", () => {
        const edges: ImportEdge[] = [{ from: "pi-core/register.ts", to: "modules/subagents/interfaces/host.ts" }];
        expect(violationsFor(edges)).toEqual(["pi-core/register.ts -> modules/subagents/interfaces/host.ts"]);
    });

    test("UI -> Module Extension (interfaces/pi) is a violation", () => {
        const edges: ImportEdge[] = [{ from: "ui/state/controller.ts", to: "modules/subagents/interfaces/pi.ts" }];
        expect(violationsFor(edges)).toEqual(["ui/state/controller.ts -> modules/subagents/interfaces/pi.ts"]);
    });

    test("App -> Module UI Entry or Extension is a violation", () => {
        const edges: ImportEdge[] = [
            { from: "app/index.tsx", to: "modules/subagents/interfaces/ui.ts" },
            { from: "app/index.tsx", to: "modules/web/interfaces/pi.ts" },
        ];
        expect(violationsFor(edges)).toEqual([
            "app/index.tsx -> modules/subagents/interfaces/ui.ts",
            "app/index.tsx -> modules/web/interfaces/pi.ts",
        ]);
    });

    test("App -> UI beyond the start function is a violation", () => {
        const edges: ImportEdge[] = [{ from: "app/index.tsx", to: "ui/components/app.tsx" }];
        expect(violationsFor(edges)).toEqual(["app/index.tsx -> ui/components/app.tsx"]);
    });

    test("Module -> UI, App, or Pi Core is a violation", () => {
        const edges: ImportEdge[] = [
            { from: "modules/subagents/runner.ts", to: "ui/state/format.ts" },
            { from: "modules/subagents/runner.ts", to: "app/index.tsx" },
            { from: "modules/web/search.ts", to: "pi-core/register.ts" },
        ];
        expect(violationsFor(edges)).toEqual([
            "modules/subagents/runner.ts -> ui/state/format.ts",
            "modules/subagents/runner.ts -> app/index.tsx",
            "modules/web/search.ts -> pi-core/register.ts",
        ]);
    });

    test("shared -> anything above shared is a violation", () => {
        const edges: ImportEdge[] = [
            { from: "shared/lib/validate.ts", to: "modules/web/interfaces/pi.ts" },
            { from: "shared/lib/validate.ts", to: "pi-core/register.ts" },
            { from: "shared/lib/validate.ts", to: "ui/start.tsx" },
            { from: "shared/lib/validate.ts", to: "app/index.tsx" },
        ];
        expect(checkBoundaries(edges)).toHaveLength(4);
    });

    test("production code -> test support is a violation", () => {
        const edges: ImportEdge[] = [{ from: "modules/web/search.ts", to: "test-support/wait.ts" }];
        expect(violationsFor(edges)).toEqual(["modules/web/search.ts -> test-support/wait.ts"]);
    });

    test("an import resolving outside the known layers is a violation", () => {
        const edges: ImportEdge[] = [{ from: "modules/web/search.ts", to: "scripts/build.ts" }];
        expect(violationsFor(edges)).toEqual(["modules/web/search.ts -> scripts/build.ts"]);
    });

    test("each violation names its rule", () => {
        const [violation] = checkBoundaries([
            { from: "modules/web/search.ts", to: "modules/subagents/interfaces/pi.ts" },
        ]);
        expect(violation?.rule).toContain("Module");
    });
});

describe("test-file scoping", () => {
    test("test files may cross boundaries", () => {
        const edges: ImportEdge[] = [
            { from: "pi-core/register.test.ts", to: "ui/state/controller.ts" },
            { from: "pi-core/register.test.ts", to: "modules/file-search/interfaces/ui.ts" },
            { from: "ui/state/controller-background-lifecycle.test.ts", to: "modules/subagents/interfaces/pi.ts" },
            { from: "modules/web/tool-shell.test.ts", to: "test-support/extension-api.ts" },
        ];
        expect(checkBoundaries(edges)).toEqual([]);
    });

    test("files under a test-support directory may cross boundaries", () => {
        const edges: ImportEdge[] = [
            { from: "test-support/extension-api.ts", to: "shared/lib/validate.ts" },
            { from: "modules/subagents/test-support/fixture.ts", to: "test-support/wait.ts" },
        ];
        expect(checkBoundaries(edges)).toEqual([]);
    });

    test("a test file must still not be imported by production code", () => {
        const edges: ImportEdge[] = [{ from: "modules/web/search.ts", to: "modules/web/tool-shell.test.ts" }];
        expect(checkBoundaries(edges)).toHaveLength(1);
    });
});

describe("import spelling", () => {
    test("a Module-local test-support directory is part of its Module for spelling", () => {
        const edges: ImportEdge[] = [
            {
                from: "modules/subagents/test-support/fixture.ts",
                to: "modules/subagents/protocol.ts",
                specifier: "../protocol.js",
            },
            {
                from: "modules/subagents/protocol.test.ts",
                to: "modules/subagents/test-support/fixture.ts",
                specifier: "./test-support/fixture.js",
            },
            {
                from: "modules/subagents/test-support/fixture.ts",
                to: "test-support/wait.ts",
                specifier: "#test-support/wait.js",
            },
        ];
        expect(checkBoundaries(edges)).toEqual([]);
    });

    test("a cross-layer import spelled with a # alias is judged by the layer rules", () => {
        const edges: ImportEdge[] = [
            { from: "ui/state/controller.ts", to: "shared/lib/validate.ts", specifier: "#shared/lib/validate.js" },
            { from: "app/index.tsx", to: "ui/start.tsx", specifier: "#ui/start.tsx" },
            {
                from: "pi-core/register.ts",
                to: "modules/web/interfaces/pi.ts",
                specifier: "#modules/web/interfaces/pi.js",
            },
            { from: "ui/state/controller.ts", to: "ui/state/format.ts", specifier: "./format.js" },
            { from: "modules/web/interfaces/pi.ts", to: "modules/web/search.ts", specifier: "../search.js" },
        ];
        expect(checkBoundaries(edges)).toEqual([]);
    });

    test("a relative import that crosses a layer boundary is a violation", () => {
        const edges: ImportEdge[] = [
            { from: "ui/state/controller.ts", to: "shared/lib/validate.ts", specifier: "../../shared/lib/validate.js" },
        ];
        expect(violationsFor(edges)).toEqual(["ui/state/controller.ts -> shared/lib/validate.ts"]);
        expect(checkBoundaries(edges)[0]?.rule).toContain("#shared/");
    });

    test("a # alias used within a layer or Module is a violation", () => {
        const edges: ImportEdge[] = [
            { from: "ui/state/controller.ts", to: "ui/state/format.ts", specifier: "#ui/state/format.js" },
            { from: "modules/web/interfaces/pi.ts", to: "modules/web/search.ts", specifier: "#modules/web/search.js" },
        ];
        expect(violationsFor(edges)).toEqual([
            "ui/state/controller.ts -> ui/state/format.ts",
            "modules/web/interfaces/pi.ts -> modules/web/search.ts",
        ]);
        expect(checkBoundaries(edges)[0]?.rule).toContain("relative");
    });

    test("an unresolvable # specifier is a violation", () => {
        const edges: ImportEdge[] = [
            { from: "ui/state/controller.ts", to: "#nope/thing.js", specifier: "#nope/thing.js" },
        ];
        expect(violationsFor(edges)).toEqual(["ui/state/controller.ts -> #nope/thing.js"]);
        expect(checkBoundaries(edges)[0]?.rule).toContain("package.json");
    });

    test("test files are exempt from the layer rules but not from the spelling rule", () => {
        const edges: ImportEdge[] = [
            { from: "pi-core/register.test.ts", to: "ui/state/controller.ts", specifier: "#ui/state/controller.js" },
            { from: "pi-core/register.test.ts", to: "ui/state/format.ts", specifier: "../ui/state/format.js" },
            {
                from: "test-support/extension-api.ts",
                to: "shared/lib/validate.ts",
                specifier: "../shared/lib/validate.js",
            },
        ];
        expect(violationsFor(edges)).toEqual([
            "pi-core/register.test.ts -> ui/state/format.ts",
            "test-support/extension-api.ts -> shared/lib/validate.ts",
        ]);
    });

    test("edges without a specifier are judged by the layer rules alone", () => {
        const edges: ImportEdge[] = [{ from: "ui/state/controller.ts", to: "shared/lib/validate.ts" }];
        expect(checkBoundaries(edges)).toEqual([]);
    });
});

describe("collectImportEdges", () => {
    test("resolves relative and # alias specifiers, keeps unmatched # specifiers, skips aliased assets", () => {
        const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pui-boundaries-"));
        try {
            const sourceRoot = path.join(packageRoot, "src");
            fs.mkdirSync(path.join(sourceRoot, "ui", "state"), { recursive: true });
            fs.mkdirSync(path.join(sourceRoot, "shared", "lib"), { recursive: true });
            fs.writeFileSync(path.join(sourceRoot, "shared", "lib", "validate.ts"), "export const x = 1;\n");
            fs.writeFileSync(path.join(sourceRoot, "ui", "state", "format.ts"), "export const y = 1;\n");
            fs.writeFileSync(path.join(sourceRoot, "shared", "lib", "guidance.md"), "# guidance\n");
            fs.writeFileSync(
                path.join(sourceRoot, "ui", "state", "controller.ts"),
                [
                    'import { x } from "#shared/lib/validate.js";',
                    'import { y } from "./format.js";',
                    'import { z } from "#nope/thing.js";',
                    'import { w } from "../../shared/lib/validate.js";',
                    'import guidance from "#shared/lib/guidance.md" with { type: "text" };',
                    'import * as fs from "node:fs";',
                    "export const all = [x, y, z, w, guidance, fs];",
                ].join("\n"),
            );
            const edges = collectImportEdges(sourceRoot, {
                packageRoot,
                imports: { "#shared/*": "./src/shared/*", "#ui/*": "./src/ui/*" },
            });
            expect(edges).toEqual([
                { from: "ui/state/controller.ts", to: "shared/lib/validate.ts", specifier: "#shared/lib/validate.js" },
                { from: "ui/state/controller.ts", to: "ui/state/format.ts", specifier: "./format.js" },
                { from: "ui/state/controller.ts", to: "#nope/thing.js", specifier: "#nope/thing.js" },
                {
                    from: "ui/state/controller.ts",
                    to: "shared/lib/validate.ts",
                    specifier: "../../shared/lib/validate.js",
                },
            ]);
        } finally {
            fs.rmSync(packageRoot, { recursive: true, force: true });
        }
    });
});
