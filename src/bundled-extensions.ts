import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
    createDefaultFileSearchDependencies,
    type FileSearchExtensionDependencies,
    registerFileSearchExtension,
} from "../extensions/file-search/index.js";
import {
    createDefaultSubagentDependencies,
    registerSubagentExtension,
    type SubagentExtensionDependencies,
} from "../extensions/subagent/index.js";
import {
    createDefaultWebDependencies,
    registerWebExtension,
    type WebExtensionDependencies,
} from "../extensions/web/index.js";
import {
    createDefaultWorkflowDependencies,
    registerWorkflowExtension,
    type WorkflowExtensionDependencies,
} from "../extensions/workflow/index.js";

export interface BundledExtensionFactoryOptions {
    fileSearch?: FileSearchExtensionDependencies;
    subagent?: SubagentExtensionDependencies;
    workflow?: WorkflowExtensionDependencies;
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
            name: "pui-workflow",
            factory: (pi) => registerWorkflowExtension(pi, createDefaultWorkflowDependencies(options.workflow)),
        },
        {
            name: "pui-web",
            factory: (pi) => registerWebExtension(pi, createDefaultWebDependencies(options.web)),
        },
    ];
}

export const BUNDLED_EXTENSION_FACTORIES: InlineExtension[] = createBundledExtensionFactories();
