/** Poll until the predicate holds, sleeping briefly between checks; throws after the timeout. */
export async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5_000,
    message = "Timed out waiting for condition",
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await Bun.sleep(5);
    }
}
