import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl from "./crawl.ts";
import { WebOutputRetention, type WebOutputRetentionDependencies } from "./output-retention.ts";
import registerSearch from "./search.ts";
import type { WebToolDependencies } from "./tool-shell.ts";

/** Provider dependencies and optional complete-output retention settings for the web extension. */
export type WebExtensionDependencies = WebToolDependencies & {
    /** Storage and quota overrides applied to the session output-retention owner. */
    outputRetention?: WebOutputRetentionDependencies;
};

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
    const outputRetention = new WebOutputRetention(dependencies.outputRetention);
    registerSearch(pi, dependencies, outputRetention);
    registerCrawl(pi, dependencies, outputRetention);
    pi.on("session_start", () => outputRetention.startSession());
    pi.on("session_shutdown", async () => {
        await outputRetention.cleanup();
    });
}

export default registerWebExtension;
