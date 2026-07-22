import { describe, expect, test } from "bun:test";
import { cycleIndex } from "./list-navigation.js";

describe("list navigation", () => {
  test("cycles forward and backward at list boundaries", () => {
    expect(cycleIndex(2, 1, 3)).toBe(0);
    expect(cycleIndex(0, -1, 3)).toBe(2);
  });

  test("moves within the list", () => {
    expect(cycleIndex(1, 1, 3)).toBe(2);
    expect(cycleIndex(1, -1, 3)).toBe(0);
  });

  test("stays at zero for an empty list", () => {
    expect(cycleIndex(0, 1, 0)).toBe(0);
    expect(cycleIndex(0, -1, 0)).toBe(0);
  });
});
