import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl, { type WebCrawlDependencies } from "./crawl.ts";
import { WebOutputRetention, type WebOutputRetentionAdapter } from "./output-retention.ts";
import registerSearch, { type WebSearchDependencies } from "./search.ts";

export type WebExtensionDependencies = WebSearchDependencies &
    WebCrawlDependencies & {
        createOutputRetention?: () => WebOutputRetentionAdapter;
    };

class SessionOutputRetention implements WebOutputRetentionAdapter {
    private owner: WebOutputRetentionAdapter | undefined;
    private readonly retiredOwners = new Set<WebOutputRetentionAdapter>();
    private cleanupQueue = Promise.resolve(true);

    constructor(private readonly createOwner: () => WebOutputRetentionAdapter) {}

    retain(fullText: string, limits: { maxBytes: number; maxLines: number }) {
        this.owner ??= this.createOwner();
        return this.owner.retain(fullText, limits);
    }

    cleanup(): Promise<boolean> {
        if (this.owner) this.retiredOwners.add(this.owner);
        this.owner = undefined;
        this.cleanupQueue = this.cleanupQueue.then(() => this.cleanupRetiredOwners());
        return this.cleanupQueue;
    }

    private async cleanupRetiredOwners(): Promise<boolean> {
        await Promise.all(
            [...this.retiredOwners].map(async (owner) => {
                try {
                    if (await owner.cleanup()) this.retiredOwners.delete(owner);
                } catch {
                    // Keep failed owners so a later session shutdown can retry them.
                }
            }),
        );
        return this.retiredOwners.size === 0;
    }
}

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
    const outputRetention = new SessionOutputRetention(
        dependencies.createOutputRetention ?? (() => new WebOutputRetention()),
    );
    registerSearch(pi, dependencies, outputRetention);
    registerCrawl(pi, dependencies, outputRetention);
    pi.on("session_shutdown", async () => {
        await outputRetention.cleanup();
    });
}

export default registerWebExtension;
