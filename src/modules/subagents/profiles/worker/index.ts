import { defineProfile } from "../profile.js";
import systemPrompt from "./prompt.md" with { type: "text" };

export default defineProfile({
    name: "worker",
    label: "Worker",
    description:
        "Start a write-capable background subagent for delegated implementation, debugging, testing, or review and return its Job id immediately. " +
        "The result is injected as soon as it completes. The child can edit files and run arbitrary shell commands and is not sandboxed.",
    promptSnippet: "Delegate write-capable coding work to a background subagent",
    promptGuidelines: [
        "Use worker when the user asks to delegate implementation, debugging, testing, review, or other write-capable coding work.",
        "Give worker a focused, self-contained prompt; child context files, skills, and extensions are disabled.",
        "Issue multiple independent worker calls in the same turn when their tasks can run in parallel.",
        "After worker starts, do not wait or poll subagent_list. Continue only independent useful work; otherwise end your turn while it runs in the background.",
    ],
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    model: "openrouter/z-ai/glm-5.3-flash",
    thinkingLevel: "high",
    systemPrompt,
    promptMode: "append",
});
