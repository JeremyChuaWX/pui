import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl, { type WebCrawlDependencies } from "./crawl.ts";
import { WebOutputRetention, type WebOutputRetentionAdapter } from "./output-retention.ts";
import registerSearch, { type WebSearchDependencies } from "./search.ts";

export type WebExtensionDependencies = WebSearchDependencies &
    WebCrawlDependencies & {
        outputRetention?: WebOutputRetentionAdapter;
    };

class SessionOutputRetention implements WebOutputRetentionAdapter {
    private owner: WebOutputRetentionAdapter = new WebOutputRetention();

    retain(fullText: string, limits: { maxBytes: number; maxLines: number }) {
        return this.owner.retain(fullText, limits);
    }

    async cleanup(): Promise<void> {
        const oldOwner = this.owner;
        this.owner = new WebOutputRetention();
        await oldOwner.cleanup();
    }
}

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
    const outputRetention = dependencies.outputRetention ?? new SessionOutputRetention();
    registerSearch(pi, dependencies, outputRetention);
    registerCrawl(pi, dependencies, outputRetention);
    pi.on("session_shutdown", () => outputRetention.cleanup());
}

export default registerWebExtension;
