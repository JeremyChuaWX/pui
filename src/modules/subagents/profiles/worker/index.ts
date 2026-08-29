import { defineProfile } from "../profile.js";
import prompt from "./prompt.md" with { type: "text" };

export default defineProfile({
    name: "worker",
    label: "Worker",
    description:
        "Start a write-capable Pi subagent for delegated implementation, debugging, testing, or review and return its Job id immediately. " +
        "The child can edit files and run arbitrary shell commands and is not sandboxed.",
    promptSnippet: "Delegate write-capable coding work to an isolated background subagent",
    promptGuidelines: [
        "Use worker instead of bash launching headless Pi when the user asks to delegate implementation, debugging, testing, review, or other write-capable coding work.",
        "Give worker a focused, self-contained prompt and the exact working directory because child context files, skills, and extensions are disabled.",
        "Issue multiple independent worker calls in the same turn when their tasks can run in parallel.",
        "After worker starts, continue useful parent work; use subagent_wait only when progress depends on its result.",
    ],
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    defaultModel: "openrouter/z-ai/glm-5.3-flash:high",
    modelEnv: "PI_WORKER_MODEL",
    prompt,
    promptFlag: "--append-system-prompt",
});
