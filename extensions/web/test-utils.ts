export function lineCount(text: string): number {
    return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await Bun.sleep(1);
    }
    throw new Error("Timed out waiting for condition");
}
