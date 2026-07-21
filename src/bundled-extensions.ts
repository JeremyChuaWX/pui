import { fileURLToPath } from "node:url";

export const BUNDLED_EXTENSION_PATHS = [
  fileURLToPath(new URL("../extensions/subagent/index.ts", import.meta.url)),
];
