import { describe, expect, test } from "bun:test";
import { RetainedOutputQuota } from "./retained-output.ts";

describe("RetainedOutputQuota", () => {
    test("shares concurrent cleanup and retries failed callbacks without losing ownership", async () => {
        let attempts = 0;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const quota = new RetainedOutputQuota();
        await quota.retain(4, async () => {
            attempts++;
            await blocked;
            if (attempts === 1) throw new Error("busy");
        });

        const first = quota.cleanup();
        const concurrent = quota.cleanup();
        expect(first).toBe(concurrent);
        release();
        expect(await first).toBe(false);
        expect(attempts).toBe(1);
        expect(await quota.cleanup()).toBe(true);
        expect(attempts).toBe(2);
    });

    test("owns failed rejected cleanups for retry and reopens with fresh session accounting", async () => {
        const quota = new RetainedOutputQuota({ maxResultBytes: 5, maxSessionBytes: 5 });
        let rejectedAttempts = 0;
        expect(
            await quota.retain(6, async () => {
                rejectedAttempts++;
                if (rejectedAttempts === 1) throw new Error("busy");
            }),
        ).toBe(false);
        expect(await quota.cleanup()).toBe(true);
        expect(rejectedAttempts).toBe(2);

        let oldCleaned = 0;
        expect(
            await quota.retain(1, async () => {
                oldCleaned++;
            }),
        ).toBe(false);
        expect(oldCleaned).toBe(1);
        quota.startSession();
        expect(
            await quota.retain(5, async () => {
                oldCleaned++;
            }),
        ).toBe(true);
        expect(await quota.retain(1, async () => {})).toBe(false);
        expect(await quota.cleanup()).toBe(true);
        expect(oldCleaned).toBe(2);
    });
});
