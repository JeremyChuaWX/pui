import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
    createDefaultFileSearchDependencies,
    type FileSearchExtensionDependencies,
    registerFileSearchExtension,
} from "#modules/file-search/interfaces/pi.js";
import {
    createDefaultSubagentDependencies,
    registerSubagentExtension,
    type SubagentExtensionDependencies,
} from "#modules/subagents/interfaces/pi.js";
import {
    createDefaultWebDependencies,
    registerWebExtension,
    type WebExtensionDependencies,
} from "#modules/web/interfaces/pi.js";

export interface BundledExtensionFactoryOptions {
    fileSearch?: FileSearchExtensionDependencies;
    subagent?: SubagentExtensionDependencies;
    web?: WebExtensionDependencies;
}

/** Compose bundled extensions with explicit production collaborators or injected test fakes. */
export function createBundledExtensionFactories(options: BundledExtensionFactoryOptions = {}): InlineExtension[] {
    return [
        {
            name: "pui-file-search",
            factory: (pi) => registerFileSearchExtension(pi, createDefaultFileSearchDependencies(options.fileSearch)),
        },
        {
            name: "pui-subagent",
            factory: (pi) => registerSubagentExtension(pi, createDefaultSubagentDependencies(options.subagent)),
        },
        {
            name: "pui-web",
            factory: (pi) => registerWebExtension(pi, createDefaultWebDependencies(options.web)),
        },
    ];
}

export const BUNDLED_EXTENSION_FACTORIES: InlineExtension[] = createBundledExtensionFactories();
