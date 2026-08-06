import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl from "./crawl.ts";
import { WebOutputRetention, type WebOutputRetentionDependencies } from "./output-retention.ts";
import registerSearch from "./search.ts";
import type { WebToolDependencies } from "./tool-shell.ts";

/** Provider dependencies and optional complete-output retention settings for the web extension. */
export type WebExtensionDependencies = WebToolDependencies & {
    /** Storage and quota overrides used when no owner is supplied. */
    outputRetention?: WebOutputRetentionDependencies;
    /** Session output-retention owner; supplied by production composition roots and tests. */
    outputRetentionOwner?: WebOutputRetention;
};

/** Production fetch, environment, and session retention owner. */
export function createDefaultWebDependencies(
    overrides: WebExtensionDependencies = {},
): Required<Pick<WebExtensionDependencies, "fetch" | "environment" | "outputRetentionOwner">> {
    return {
        fetch: overrides.fetch ?? globalThis.fetch,
        environment: overrides.environment ?? process.env,
        outputRetentionOwner: overrides.outputRetentionOwner ?? new WebOutputRetention(overrides.outputRetention),
    };
}

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
    const resolved = createDefaultWebDependencies(dependencies);
    const outputRetention = resolved.outputRetentionOwner;
    registerSearch(pi, resolved, outputRetention);
    registerCrawl(pi, resolved, outputRetention);
    pi.on("session_start", () => outputRetention.startSession());
    pi.on("session_shutdown", async () => {
        await outputRetention.cleanup();
    });
}

export default function webExtension(pi: ExtensionAPI): void {
    registerWebExtension(pi, createDefaultWebDependencies());
}
