import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, defineProfile, describeProfile, profileLimits } from "./profile.ts";

const MINUTE = 60_000;

function declare(overrides: Record<string, unknown> = {}) {
    return defineProfile({
        name: "fixture",
        label: "Fixture",
        description: "A fixture Profile.",
        promptSnippet: "fixture",
        promptGuidelines: [],
        tools: ["read"],
        defaultModel: "fixture/model",
        modelEnv: "PI_FIXTURE_MODEL",
        prompt: "prompt",
        promptFlag: "--system-prompt",
        ...overrides,
    });
}

describe("Profile Limits", () => {
    test("a declaration without Limits gets the defaults", () => {
        expect(profileLimits(declare())).toEqual(DEFAULT_LIMITS);
        expect(DEFAULT_LIMITS).toEqual({
            wallClockMs: 60 * MINUTE,
            stallTimeoutMs: 10 * MINUTE,
            toolStallTimeoutMs: 15 * MINUTE,
        });
    });

    test("a declaration may override any one Limit and the description states the effective values", () => {
        const profile = declare({ toolStallTimeoutMs: 45 * MINUTE, stallTimeoutMs: 2.5 * MINUTE });
        expect(profileLimits(profile)).toEqual({
            wallClockMs: 60 * MINUTE,
            stallTimeoutMs: 2.5 * MINUTE,
            toolStallTimeoutMs: 45 * MINUTE,
        });
        expect(describeProfile(profile)).toContain("60 minutes wall clock, 2.5 minutes stall, 45 minutes tool stall");
    });

    test("a zero Limit is described as disabled", () => {
        expect(describeProfile(declare({ wallClockMs: 0 }))).toContain("disabled wall clock");
    });
});
