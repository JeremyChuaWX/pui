import * as fs from "node:fs";
import * as os from "node:os";
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

const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-compiled-workflow-"));
try {
    const workflow = run(["--workflow-smoke"], {
        PUI_WORKFLOWS: "1",
        PUI_WORKFLOW_SMOKE: "1",
        PUI_WORKFLOW_SMOKE_ROOT: temp,
    });
    if (workflow.exitCode !== 0) throw new Error(`Compiled workflow smoke failed: ${workflow.stderr.toString()}`);
    const result = JSON.parse(workflow.stdout.toString()) as Record<string, unknown>;
    if (
        result.hostExecutable !== executablePath ||
        JSON.stringify(result.completed) !== JSON.stringify(["left-done", "right-done"]) ||
        result.stopped !== "cancelled" ||
        result.deliveries !== 2 ||
        result.recovered !== true
    )
        throw new Error(`Unexpected compiled workflow smoke result: ${JSON.stringify(result)}`);

    const oldNode = path.join(temp, process.platform === "win32" ? "old-node.cmd" : "old-node");
    await fs.promises.writeFile(
        oldNode,
        process.platform === "win32" ? "@echo off\r\necho v20.0.0\r\n" : "#!/bin/sh\necho v20.0.0\n",
        { mode: 0o755 },
    );
    const old = run(["--workflow-smoke"], {
        PUI_WORKFLOWS: "1",
        PUI_WORKFLOW_SMOKE: "1",
        PUI_WORKFLOW_SMOKE_ROOT: path.join(temp, "old"),
        PUI_WORKFLOW_NODE: oldNode,
        PATH: "",
    });
    const diagnostic = old.stderr.toString();
    if (old.exitCode === 0 || !diagnostic.includes("external Node >=22.19") || !diagnostic.includes("found v20.0.0"))
        throw new Error(`Old Node did not produce an actionable error: ${diagnostic}`);
} finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
}
