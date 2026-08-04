import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import explorePrompt from "../subagent/agents/explore.md" with { type: "text" };
import workerPrompt from "../subagent/agents/worker.md" with { type: "text" };

export const AGENT_NAMES = ["worker", "explore"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export type ResolvedAgentName = AgentName | "generic";

export interface AgentPreset {
    description: string;
    tools: readonly string[];
    defaultModel?: string;
    modelEnv?: string;
    prompt?: string;
    promptFlag?: "--system-prompt" | "--append-system-prompt";
    timeoutMs: number;
}

export const AGENTS: Record<ResolvedAgentName, AgentPreset> = {
    generic: {
        description: "general coding without bundled agent guidance",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        timeoutMs: 600_000,
    },
    worker: {
        description: "general coding with Ponytail standards",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        defaultModel: "openai-codex/gpt-5.6-sol:low",
        modelEnv: "PI_WORKER_MODEL",
        prompt: workerPrompt,
        promptFlag: "--append-system-prompt",
        timeoutMs: 600_000,
    },
    explore: {
        description: "read-only codebase exploration",
        tools: ["read", "grep", "find", "ls"],
        defaultModel: "openai-codex/gpt-5.4-mini:off",
        modelEnv: "PI_EXPLORE_MODEL",
        prompt: explorePrompt,
        promptFlag: "--system-prompt",
        timeoutMs: 120_000,
    },
};

export const AGENT_SUMMARY = (["generic", ...AGENT_NAMES] as const)
    .map((name) => {
        const agent = AGENTS[name];
        return `${name} (${agent.description}; tools: ${agent.tools.join(", ")}; default model: ${agent.defaultModel ?? "child Pi default"})`;
    })
    .join("; ");

export function resolveModel(
    agent: AgentPreset,
    override: string | undefined,
    environment: NodeJS.ProcessEnv,
): string | undefined {
    const explicit = override?.trim();
    if (explicit) return explicit;
    const configured = agent.modelEnv ? environment[agent.modelEnv]?.trim() : undefined;
    return configured || agent.defaultModel;
}

export function workingDirectoryCandidate(input: string, parentCwd: string): string {
    let value = input.trim().replace(/^@/, "");
    if (!value) return path.resolve(parentCwd);
    if (value === "~") value = os.homedir();
    else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
    return path.resolve(parentCwd, value);
}

export async function resolveWorkingDirectory(input: string, parentCwd: string): Promise<string> {
    if (!input.trim().replace(/^@/, "")) throw new Error("Subagent cwd must not be empty.");
    const resolved = workingDirectoryCandidate(input, parentCwd);
    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(resolved);
    } catch {
        throw new Error(`Subagent cwd does not exist: ${resolved}`);
    }
    if (!stats.isDirectory()) throw new Error(`Subagent cwd is not a directory: ${resolved}`);
    return fs.promises.realpath(resolved);
}

export function childArgs(agent: AgentPreset, model: string | undefined, prompt: string): string[] {
    const args = [
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        agent.tools.join(","),
    ];
    if (model) args.push("--model", model);
    if (agent.promptFlag && agent.prompt !== undefined) args.push(agent.promptFlag, agent.prompt);
    args.push(prompt);
    return args;
}
