import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import fileSearchExtension from "../extensions/file-search/index.js";
import subagentExtension from "../extensions/subagent/index.js";
import webExtension from "../extensions/web/index.js";
import workflowExtension from "../extensions/workflow/index.js";

export const BUNDLED_SUBAGENT_SOURCE_PATH = fileURLToPath(new URL("../extensions/subagent/index.ts", import.meta.url));

export const BUNDLED_EXTENSION_FACTORIES: InlineExtension[] = [
    { name: "pui-file-search", factory: fileSearchExtension },
    { name: "pui-subagent", factory: subagentExtension },
    { name: "pui-workflow", factory: workflowExtension },
    { name: "pui-web", factory: webExtension },
];
