import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCrawl, { type WebCrawlDependencies } from "./crawl.ts";
import registerSearch, { type WebSearchDependencies } from "./search.ts";

export type WebExtensionDependencies = WebSearchDependencies & WebCrawlDependencies;

/** Registers the application-owned web discovery and extraction tools. */
export function registerWebExtension(pi: ExtensionAPI, dependencies: WebExtensionDependencies = {}): void {
  registerSearch(pi, dependencies);
  registerCrawl(pi, dependencies);
}

export default registerWebExtension;
