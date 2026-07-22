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

const result = Bun.spawnSync([executablePath, "--help"], {
  cwd: projectDir,
  stdout: "ignore",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  throw new Error(`Standalone executable smoke test failed with exit code ${result.exitCode}`);
}
