import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl, { type WebCrawlDependencies } from "./crawl.ts";
import { WebOutputRetention, type WebOutputRetentionAdapter } from "./output-retention.ts";
import registerSearch, { type WebSearchDependencies } from "./search.ts";

export type WebExtensionDependencies = WebSearchDependencies &
    WebCrawlDependencies & {
        outputRetention?: WebOutputRetentionAdapter;
    };

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
    const outputRetention = dependencies.outputRetention ?? new WebOutputRetention();
    registerSearch(pi, dependencies, outputRetention);
    registerCrawl(pi, dependencies, outputRetention);
    pi.on("session_shutdown", async () => {
        await outputRetention.cleanup();
    });
}

export default registerWebExtension;
