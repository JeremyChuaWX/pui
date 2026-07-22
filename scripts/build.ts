import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const projectDir = path.resolve(import.meta.dir, "..");
const distDir = path.join(projectDir, "dist");
const executableName = process.platform === "win32" ? "pui.exe" : "pui";
const executablePath = path.join(distDir, executableName);

const initialCwd = process.cwd();
const buildDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-build-"));
try {
  process.chdir(buildDir);
  await fs.promises.rm(distDir, { recursive: true, force: true });
  await fs.promises.mkdir(distDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [path.join(projectDir, "src", "index.tsx")],
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [createSolidTransformPlugin()],
    compile: {
      outfile: executablePath,
    },
  });
  // Compiled executables embed the compressed source map; remove Bun's redundant sidecar.
  await Promise.all(
    result.outputs
      .filter((output) => output.kind === "sourcemap")
      .map((output) => fs.promises.rm(output.path, { force: true })),
  );
  if (process.platform !== "win32") await fs.promises.chmod(executablePath, 0o755);

  const size = (await fs.promises.stat(executablePath)).size;
  process.stdout.write(`built ${path.relative(projectDir, executablePath)} (${(size / 1024 / 1024).toFixed(1)} MiB)\n`);
} finally {
  process.chdir(initialCwd);
  await fs.promises.rm(buildDir, { recursive: true, force: true });
}
