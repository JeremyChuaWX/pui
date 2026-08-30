import { defineProfile } from "../profile.js";
import systemPrompt from "./prompt.md" with { type: "text" };

export default defineProfile({
    name: "explorer",
    label: "Explorer",
    description:
        "Start a read-only background subagent for focused codebase exploration and return its Job id immediately. " +
        "The result is injected as soon as it completes. The child can read, grep, find, and list files, but cannot run shell commands or modify files.",
    promptSnippet: "Delegate read-only codebase exploration to a background subagent",
    promptGuidelines: [
        "Use explorer for read-only codebase exploration, locating relevant code, and explaining existing behavior.",
        "Give explorer a focused, self-contained prompt; child context files, skills, and extensions are disabled.",
        "After explorer starts, do not wait or poll subagent_list. Continue only independent useful work; otherwise end your turn while it runs in the background.",
    ],
    tools: ["read", "grep", "find", "ls"],
    model: "openrouter/z-ai/glm-5.3-flash",
    thinkingLevel: "low",
    systemPrompt,
    promptMode: "replace",
});
