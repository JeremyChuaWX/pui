import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl, { type WebCrawlDependencies } from "./crawl.ts";
import {
    WebOutputRetention,
    type WebOutputRetentionAdapter,
    type WebOutputRetentionDependencies,
} from "./output-retention.ts";
import registerSearch, { type WebSearchDependencies } from "./search.ts";

export type WebExtensionDependencies = WebSearchDependencies &
    WebCrawlDependencies & {
        outputRetention?: WebOutputRetentionDependencies;
    };

class SessionOutputRetention implements WebOutputRetentionAdapter {
    private owner: WebOutputRetentionAdapter | undefined;
    private shutdownOwner: WebOutputRetentionAdapter | undefined;
    private readonly retiredOwners = new Set<WebOutputRetentionAdapter>();
    private acceptingResults = true;
    private cleanupQueue = Promise.resolve(true);

    constructor(private readonly ownerDependencies: WebOutputRetentionDependencies) {}

    startSession(): void {
        this.acceptingResults = true;
        this.shutdownOwner = undefined;
    }

    retain(fullText: string, limits: { maxBytes: number; maxLines: number }) {
        if (!this.acceptingResults) {
            this.shutdownOwner ??= this.closedOwner();
            return this.shutdownOwner.retain(fullText, limits);
        }
        this.owner ??= new WebOutputRetention(this.ownerDependencies);
        return this.owner.retain(fullText, limits);
    }

    cleanup(): Promise<boolean> {
        this.acceptingResults = false;
        const currentOwner = this.owner;
        let currentCleanup: Promise<boolean> | undefined;
        if (currentOwner) {
            this.retiredOwners.add(currentOwner);
            this.shutdownOwner = currentOwner;
            currentCleanup = currentOwner.cleanup();
        }
        this.owner = undefined;
        this.cleanupQueue = this.cleanupQueue.then(async () => {
            if (currentOwner && currentCleanup) {
                try {
                    if (await currentCleanup) this.retiredOwners.delete(currentOwner);
                } catch {
                    // Keep failed owners so a later session shutdown can retry them.
                }
            }
            await this.cleanupRetiredOwners(currentOwner);
            return this.retiredOwners.size === 0;
        });
        return this.cleanupQueue;
    }

    private closedOwner(): WebOutputRetentionAdapter {
        const owner = new WebOutputRetention(this.ownerDependencies);
        void owner.cleanup();
        return owner;
    }

    private async cleanupRetiredOwners(excludedOwner?: WebOutputRetentionAdapter): Promise<void> {
        await Promise.all(
            [...this.retiredOwners]
                .filter((owner) => owner !== excludedOwner)
                .map(async (owner) => {
                    try {
                        if (await owner.cleanup()) this.retiredOwners.delete(owner);
                    } catch {
                        // Keep failed owners so a later session shutdown can retry them.
                    }
                }),
        );
    }
}

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
    const outputRetention = new SessionOutputRetention(dependencies.outputRetention ?? {});
    registerSearch(pi, dependencies, outputRetention);
    registerCrawl(pi, dependencies, outputRetention);
    pi.on("session_start", () => outputRetention.startSession());
    pi.on("session_shutdown", async () => {
        await outputRetention.cleanup();
    });
}

export default registerWebExtension;
