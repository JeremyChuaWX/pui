import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import unslopLicensePath from "./skills/unslop/LICENSE.txt" with { type: "file" };
import unslopSkillPath from "./skills/unslop/SKILL.md" with { type: "file" };

export interface BundledSkill {
    name: string;
    skillPath: string;
    licensePath: string;
}

export interface BundledSkillResources {
    skills: BundledSkill[];
    skillPaths: string[];
    dispose: () => Promise<void>;
}

export interface CreateBundledSkillResourcesOptions {
    temporaryDirectory?: string;
}

/** Source assets embedded in the standalone executable through Bun's file loader. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
    {
        name: "unslop",
        skillPath: unslopSkillPath,
        licensePath: unslopLicensePath,
    },
];

/**
 * Copy embedded assets to ordinary files that Pi's tools and child processes can access.
 * Bun can read `$bunfs` assets but its `fs.access` implementation reports them as missing.
 */
export async function createBundledSkillResources(
    options: CreateBundledSkillResourcesOptions = {},
): Promise<BundledSkillResources> {
    const root = await fs.promises.mkdtemp(path.join(options.temporaryDirectory ?? os.tmpdir(), "pui-bundled-skills-"));
    const pairs = BUNDLED_SKILLS.map((source) => {
        const directory = path.join(root, source.name);
        return {
            source,
            target: {
                name: source.name,
                skillPath: path.join(directory, "SKILL.md"),
                licensePath: path.join(directory, "LICENSE.txt"),
            },
        };
    });
    const skills = pairs.map(({ target }) => target);

    try {
        await Promise.all(
            pairs.map(async ({ source, target }) => {
                const [skill, license] = await Promise.all([
                    fs.promises.readFile(source.skillPath),
                    fs.promises.readFile(source.licensePath),
                ]);
                await fs.promises.mkdir(path.dirname(target.skillPath), { recursive: true, mode: 0o700 });
                await Promise.all([
                    fs.promises.writeFile(target.skillPath, skill, { mode: 0o600 }),
                    fs.promises.writeFile(target.licensePath, license, { mode: 0o600 }),
                ]);
            }),
        );
    } catch (error) {
        await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }

    let disposal: Promise<void> | undefined;
    return {
        skills,
        skillPaths: skills.map(({ skillPath }) => skillPath),
        dispose: () => (disposal ??= fs.promises.rm(root, { recursive: true, force: true })),
    };
}
