import { describe, expect, test } from "bun:test";
import explorer from "#modules/subagents/profiles/explorer/index.js";
import { DEFAULT_LIMITS, defineProfile } from "#modules/subagents/profiles/profile.js";
import worker from "#modules/subagents/profiles/worker/index.js";

const MINUTE = 60_000;

function declare(overrides: Record<string, unknown> = {}) {
    return defineProfile({
        name: "fixture",
        label: "Fixture",
        description: "A fixture Profile.",
        promptSnippet: "fixture",
        promptGuidelines: [],
        tools: ["read"],
        model: "fixture/model",
        thinkingLevel: "low",
        systemPrompt: "prompt",
        promptMode: "replace",
        ...overrides,
    });
}

describe("subagent Profiles", () => {
    test("applies the shared inactivity and hard Limits", () => {
        expect(DEFAULT_LIMITS).toEqual({ inactivityMs: 10 * MINUTE, hardMs: 60 * MINUTE });
        expect(declare().config).toMatchObject(DEFAULT_LIMITS);
        expect(declare({ inactivityMs: MINUTE }).config).toMatchObject({
            inactivityMs: MINUTE,
            hardMs: 60 * MINUTE,
        });
    });

    test("matches the local explorer and worker capabilities", () => {
        expect(explorer.config).toMatchObject({
            tools: ["read", "grep", "find", "ls"],
            model: "openrouter/z-ai/glm-5.3-flash",
            thinkingLevel: "low",
            promptMode: "replace",
        });
        expect(worker.config).toMatchObject({
            tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
            model: "openrouter/z-ai/glm-5.3-flash",
            thinkingLevel: "high",
            promptMode: "append",
        });
        expect(explorer.config.systemPrompt).toContain("no more than 10 tool-call rounds");
        expect(worker.config.systemPrompt).toContain("Only your final message is returned to the caller");
    });
});
