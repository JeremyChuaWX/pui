import unslopLicensePath from "../skills/unslop/LICENSE.txt" with { type: "file" };
import unslopSkillPath from "../skills/unslop/SKILL.md" with { type: "file" };

/** Assets embedded in the standalone executable and readable through Bun's virtual filesystem. */
export const BUNDLED_SKILLS = [
    {
        name: "unslop",
        skillPath: unslopSkillPath,
        licensePath: unslopLicensePath,
    },
] as const;

export const BUNDLED_SKILL_PATHS: string[] = BUNDLED_SKILLS.map(({ skillPath }) => skillPath);
