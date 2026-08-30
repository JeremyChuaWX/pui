import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { BUNDLED_SKILLS, createBundledSkillResources } from "#pi-core/bundled-skills.js";

describe("bundled skills", () => {
    test("keeps the skill and its upstream license readable", async () => {
        const [unslop] = BUNDLED_SKILLS;
        expect(unslop).toBeDefined();
        const [skill, license] = await Promise.all([
            fs.promises.readFile(unslop!.skillPath, "utf8"),
            fs.promises.readFile(unslop!.licensePath, "utf8"),
        ]);

        expect(skill).toStartWith("---\nname: unslop\n");
        expect(skill).toContain("## Patterns to detect and fix");
        expect(license).toContain("MIT License");
        expect(license).toContain("Copyright (c) 2026 Lauren Tan");
    });

    test("materializes conventional, tool-readable skill directories", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-bundled-skills-test-"));
        const resources = await createBundledSkillResources({ temporaryDirectory: temp });
        const [unslop] = resources.skills;
        expect(unslop).toBeDefined();
        const root = path.dirname(path.dirname(unslop!.skillPath));

        try {
            expect(path.basename(unslop!.skillPath)).toBe("SKILL.md");
            expect(path.basename(path.dirname(unslop!.skillPath))).toBe("unslop");
            await Promise.all([
                fs.promises.access(unslop!.skillPath, fs.constants.R_OK),
                fs.promises.access(unslop!.licensePath, fs.constants.R_OK),
            ]);
            const [skill, license] = await Promise.all([
                fs.promises.readFile(unslop!.skillPath, "utf8"),
                fs.promises.readFile(unslop!.licensePath, "utf8"),
            ]);
            expect(skill).toStartWith("---\nname: unslop\n");
            expect(license).toContain("MIT License");
        } finally {
            await resources.dispose();
        }

        expect(fs.existsSync(root)).toBeFalse();
        await resources.dispose();
        await fs.promises.rm(temp, { recursive: true, force: true });
    });

    test("loads the bundled skill through Pi without disabling normal discovery", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-bundled-skills-test-"));
        const cwd = path.join(temp, "project");
        const agentDir = path.join(temp, "agent");
        const localSkillDir = path.join(agentDir, "skills", "local-writing");
        await Promise.all([
            fs.promises.mkdir(cwd, { recursive: true }),
            fs.promises.mkdir(localSkillDir, { recursive: true }),
        ]);
        await fs.promises.writeFile(
            path.join(localSkillDir, "SKILL.md"),
            "---\nname: local-writing\ndescription: Local writing fixture.\n---\n\n# Local writing\n",
        );
        const resources = await createBundledSkillResources({ temporaryDirectory: temp });

        try {
            const loader = new DefaultResourceLoader({
                cwd,
                agentDir,
                settingsManager: SettingsManager.inMemory(),
                additionalSkillPaths: resources.skillPaths,
                noExtensions: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
            });

            for (let load = 0; load < 2; load += 1) {
                await loader.reload();
                const result = loader.getSkills();
                expect(result.diagnostics).toEqual([]);
                expect(result.skills.filter(({ name }) => name === "local-writing")).toHaveLength(1);
                expect(result.skills.filter(({ name }) => name === "unslop")).toHaveLength(1);
                expect(result.skills.find(({ name }) => name === "unslop")?.filePath).toBe(resources.skillPaths[0]);
            }
        } finally {
            await resources.dispose();
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });
});
