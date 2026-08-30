import * as fs from "node:fs";
import * as path from "node:path";

const projectDir = path.resolve(import.meta.dir, "..");
const executableName = process.platform === "win32" ? "pui.exe" : "pui";
const distDir = path.join(projectDir, "dist");
const executablePath = path.join(distDir, executableName);
const artifacts = await fs.promises.readdir(distDir);
if (artifacts.length !== 1 || artifacts[0] !== executableName) {
    throw new Error(`Expected only dist/${executableName}, found: ${artifacts.join(", ") || "nothing"}`);
}

function run(args: string[], environment: Record<string, string | undefined> = {}) {
    return Bun.spawnSync([executablePath, ...args], {
        cwd: projectDir,
        env: { ...process.env, ...environment },
        stdout: "pipe",
        stderr: "pipe",
    });
}
const help = run(["--help"]);
if (help.exitCode !== 0) throw new Error(`Standalone executable smoke failed: ${help.stderr.toString()}`);

const expectedTools = ["fd", "rg", "explorer", "worker", "subagent_cancel", "subagent_list", "web_search", "web_crawl"];
const expectedSkills = ["unslop"];
const smoke = run(["--smoke"]);
if (smoke.exitCode !== 0) throw new Error(`Compiled smoke entry failed: ${smoke.stderr.toString()}`);
const report = JSON.parse(smoke.stdout.toString()) as { tools?: unknown; skills?: unknown };
const tools = Array.isArray(report.tools) ? report.tools : [];
const skills = Array.isArray(report.skills) ? report.skills : [];
const missingTools = expectedTools.filter((name) => !tools.includes(name));
const missingSkills = expectedSkills.filter((name) => !skills.includes(name));
if (missingTools.length > 0 || missingSkills.length > 0) {
    throw new Error(
        `Compiled binary is missing tools [${missingTools.join(", ")}] and skills [${missingSkills.join(", ")}]: ${smoke.stdout.toString()}`,
    );
}
