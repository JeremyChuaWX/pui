const DEFAULT_HISTORY_LIMIT = 100;

/** In-memory history for prompts entered during the current pui process. */
export class PromptHistory {
  private readonly entries: string[] = [];
  private index = -1;
  private draft = "";
  private traversing = false;

  constructor(private readonly limit = DEFAULT_HISTORY_LIMIT) {}

  get isTraversing(): boolean {
    return this.traversing;
  }

  add(text: string): void {
    this.resetBrowsing();
    const trimmed = text.trim();
    if (!trimmed || this.limit <= 0 || this.entries[0] === trimmed) return;

    this.entries.unshift(trimmed);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }

  previous(currentText: string): string | undefined {
    const nextIndex = this.index + 1;
    if (nextIndex >= this.entries.length) return undefined;

    if (this.index === -1) this.draft = currentText;
    this.index = nextIndex;
    this.traversing = true;
    return this.entries[this.index];
  }

  next(): string | undefined {
    if (this.index === -1) return undefined;

    this.index -= 1;
    if (this.index === -1) {
      this.traversing = false;
      return this.draft;
    }
    return this.entries[this.index];
  }

  resetBrowsing(): void {
    this.index = -1;
    this.draft = "";
    this.traversing = false;
  }
}
