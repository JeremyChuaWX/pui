export function lineCount(text: string): number {
    return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(1);
    }
    if (!predicate()) throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}
