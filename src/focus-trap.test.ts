import { describe, expect, test } from "bun:test";
import { trapFocus, type FocusTrapTarget } from "./focus-trap.js";

class Target implements FocusTrapTarget {
  isDestroyed = false;
  focusCount = 0;
  listener?: () => void;
  focus() { this.focusCount += 1; }
  on(_event: "blurred", listener: () => void) { this.listener = listener; }
  off(_event: "blurred", listener: () => void) {
    if (this.listener === listener) this.listener = undefined;
  }
}

describe("focus trap", () => {
  test("restores focus after blur while enabled", () => {
    const target = new Target();
    const queued: Array<() => void> = [];
    trapFocus(target, () => true, (callback) => queued.push(callback));

    target.listener?.();
    expect(target.focusCount).toBe(0);
    queued[0]?.();
    expect(target.focusCount).toBe(1);
  });

  test("allows intentional blur and can be disposed", () => {
    const target = new Target();
    const queued: Array<() => void> = [];
    let enabled = true;
    const dispose = trapFocus(target, () => enabled, (callback) => queued.push(callback));

    target.listener?.();
    enabled = false;
    queued.shift()?.();
    expect(target.focusCount).toBe(0);

    enabled = true;
    target.listener?.();
    dispose();
    queued.shift()?.();
    expect(target.focusCount).toBe(0);
    expect(target.listener).toBeUndefined();
  });
});
