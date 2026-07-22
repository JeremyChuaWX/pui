import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import subagentExtension from "../extensions/subagent/index.js";

export const BUNDLED_SUBAGENT_SOURCE_PATH = fileURLToPath(
  new URL("../extensions/subagent/index.ts", import.meta.url),
);

export const BUNDLED_EXTENSION_FACTORIES: InlineExtension[] = [
  { name: "pui-subagent", factory: subagentExtension },
];
