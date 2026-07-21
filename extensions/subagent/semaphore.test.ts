import { describe, expect, test } from "bun:test";
import { AbortableSemaphore, configuredSubagentConcurrency } from "./semaphore.ts";

describe("AbortableSemaphore", () => {
  test("limits active work, preserves FIFO order, and releases idempotently", async () => {
    const semaphore = new AbortableSemaphore(2);
    const releaseA = await semaphore.acquire();
    const releaseB = await semaphore.acquire();
    const order: string[] = [];
    const pendingC = semaphore.acquire().then((release) => {
      order.push("c");
      return release;
    });
    const pendingD = semaphore.acquire().then((release) => {
      order.push("d");
      return release;
    });

    expect(semaphore.active).toBe(2);
    expect(semaphore.queued).toBe(2);
    releaseA();
    const releaseC = await pendingC;
    releaseA();
    expect(semaphore.active).toBe(2);
    expect(order).toEqual(["c"]);
    releaseB();
    const releaseD = await pendingD;
    expect(order).toEqual(["c", "d"]);
    releaseC();
    releaseD();
    expect(semaphore.active).toBe(0);
  });

  test("queued acquisition is abortable without consuming a permit", async () => {
    const semaphore = new AbortableSemaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.queued).toBe(0);
    release();
    expect(semaphore.active).toBe(0);
  });
});

describe("configuredSubagentConcurrency", () => {
  test("uses four by default and accepts bounded positive integers", () => {
    expect(configuredSubagentConcurrency(undefined)).toBe(4);
    expect(configuredSubagentConcurrency("7")).toBe(7);
    expect(configuredSubagentConcurrency("0")).toBe(4);
    expect(configuredSubagentConcurrency("many")).toBe(4);
    expect(configuredSubagentConcurrency("1000")).toBe(4);
  });
});
