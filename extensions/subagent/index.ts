import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  appendSubagentActivity,
  createInitialSubagentDetails,
  createTerminalSubagentDetails,
  isSubagentDetailsV1,
  isTerminalSubagentStatus,
  truncateUtf8,
  updateSubagentDetails,
  type SubagentDetailsV1,
  type SubagentStatus,
} from "./protocol.js";
import { getPiInvocation, runSubagent, type RunSubagentOptions, type SubagentRunResult } from "./runner.js";
import { AbortableSemaphore, configuredSubagentConcurrency, type SemaphoreRelease } from "./semaphore.js";

const AGENT_NAMES = ["worker", "explore"] as const;
const DEFAULT_AGENT_NAME: AgentName = "worker";
type AgentName = (typeof AGENT_NAMES)[number];

type AgentPreset = {
  description: string;
  tools: readonly string[];
  defaultModel?: string;
  modelEnv: string;
  promptPath: string;
  promptFlag: "--system-prompt" | "--append-system-prompt";
  timeoutMs: number;
};

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const AGENTS: Record<AgentName, AgentPreset> = {
  worker: {
    description: "general coding with Ponytail standards",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    defaultModel: "openai-codex/gpt-5.6-sol:low",
    modelEnv: "PI_WORKER_MODEL",
    promptPath: path.join(extensionDir, "agents", "worker.md"),
    promptFlag: "--append-system-prompt",
    timeoutMs: 600_000,
  },
  explore: {
    description: "read-only codebase exploration",
    tools: ["read", "grep", "find", "ls"],
    defaultModel: "openai-codex/gpt-5.4-mini:off",
    modelEnv: "PI_EXPLORE_MODEL",
    promptPath: path.join(extensionDir, "agents", "explore.md"),
    promptFlag: "--system-prompt",
    timeoutMs: 120_000,
  },
};

const AGENT_SUMMARY = AGENT_NAMES.map((name) => {
  const agent = AGENTS[name];
  return `${name} (${agent.description}; tools: ${agent.tools.join(", ")}; default model: ${agent.defaultModel ?? "child Pi default"})`;
}).join("; ");

const SubagentParams = Type.Object({
  agent: Type.Optional(
    StringEnum(AGENT_NAMES, {
      description: `Fixed subagent configuration to use. Omit to use ${DEFAULT_AGENT_NAME}.`,
    }),
  ),
  prompt: Type.String({
    description: "Task prompt for the subagent.",
  }),
  cwd: Type.String({
    description: "Working directory for the subagent process. Relative paths resolve from the parent working directory.",
  }),
  model: Type.Optional(
    Type.String({
      description: "Optional model override. Omit to use the selected agent's default model.",
    }),
  ),
});

const processState = globalThis as typeof globalThis & {
  __piSubagentSemaphoreV1?: AbortableSemaphore;
};
const PROCESS_SEMAPHORE =
  processState.__piSubagentSemaphoreV1 ??
  (processState.__piSubagentSemaphoreV1 = new AbortableSemaphore(configuredSubagentConcurrency()));
const ERROR_PREVIEW_BYTES = 8 * 1024;

export interface SubagentExtensionDependencies {
  semaphore?: AbortableSemaphore;
  run?: (options: RunSubagentOptions) => Promise<SubagentRunResult>;
  invocation?: typeof getPiInvocation;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
}

function resolveModel(
  agent: AgentPreset,
  override: string | undefined,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const explicit = override?.trim();
  if (explicit) return explicit;
  return environment[agent.modelEnv]?.trim() || agent.defaultModel;
}

function workingDirectoryCandidate(input: string, parentCwd: string): string {
  let value = input.trim().replace(/^@/, "");
  if (!value) return path.resolve(parentCwd);
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(parentCwd, value);
}

async function resolveWorkingDirectory(input: string, parentCwd: string): Promise<string> {
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

async function saveFullOutput(output: string): Promise<string | undefined> {
  try {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    await fs.promises.chmod(directory, 0o700);
    const outputPath = path.join(directory, "output.md");
    await fs.promises.writeFile(outputPath, output, { encoding: "utf8", mode: 0o600 });
    return outputPath;
  } catch {
    return undefined;
  }
}

function lifecycleText(details: SubagentDetailsV1): string {
  const { run } = details;
  if (run.status === "queued") return `${run.agent} subagent is queued...`;
  if (run.status === "starting") return `${run.agent} subagent is starting...`;
  if (run.status === "running") return `${run.agent} subagent is running...`;
  if (run.status === "succeeded") return `${run.agent} subagent completed.`;
  return run.error || `${run.agent} subagent ${run.status}.`;
}

function combineAbortSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUsage(details: SubagentDetailsV1): string {
  const usage = details.run.usage;
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.totalTokens) parts.push(`${usage.totalTokens} tokens`);
  return parts.join(" · ");
}

function statusIcon(status: SubagentStatus): string {
  if (status === "queued") return "◌";
  if (status === "starting" || status === "running") return "◐";
  if (status === "succeeded") return "✓";
  return "✗";
}

export { getPiInvocation } from "./runner.js";

export function registerSubagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}): void {
  const semaphore = dependencies.semaphore ?? PROCESS_SEMAPHORE;
  const run = dependencies.run ?? runSubagent;
  const resolveInvocation = dependencies.invocation ?? getPiInvocation;
  const now = dependencies.now ?? Date.now;
  const environment = dependencies.environment ?? process.env;
  const shutdownController = new AbortController();
  const failedDetails = new Map<string, SubagentDetailsV1>();
  let shuttingDown = false;

  pi.on("tool_result", (event) => {
    const saved = failedDetails.get(event.toolCallId);
    if (!saved) return;
    failedDetails.delete(event.toolCallId);
    return { details: saved };
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    shutdownController.abort();
    failedDetails.clear();
  });

  pi.registerTool<typeof SubagentParams, SubagentDetailsV1>({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn an isolated Pi subagent for delegated coding work. " +
      `Available presets: ${AGENT_SUMMARY}. ` +
      `Omitting agent selects ${DEFAULT_AGENT_NAME}. An optional model argument overrides the selected agent's default. ` +
      "Output is capped at 50KB or 2000 lines.",
    promptSnippet: "Delegate implementation, review, debugging, testing, or read-only exploration to an isolated Pi subagent.",
    promptGuidelines: [
      "Use subagent instead of bash launching headless Pi when the user asks to delegate work to a worker, implementer, reviewer, or another agent.",
      'Omit subagent\'s agent argument for general coding work; use agent "explore" only for read-only reconnaissance.',
      "Give subagent a focused, self-contained prompt and the exact working directory because child context files, skills, and extensions are disabled.",
      "Issue multiple independent subagent calls in the same turn when their tasks can run in parallel.",
      "Omit subagent's model argument unless a model override is specifically useful.",
    ],
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agentName = (params.agent ?? DEFAULT_AGENT_NAME) as AgentName;
      const agent = AGENTS[agentName];
      const model = resolveModel(agent, params.model, environment);
      const cwdCandidate = workingDirectoryCandidate(params.cwd, ctx.cwd);
      let details = createInitialSubagentDetails({
        id: toolCallId,
        agent: agentName,
        model: model ?? "default",
        cwd: cwdCandidate,
        now: now(),
      });
      const combinedSignal = combineAbortSignals(signal, shutdownController.signal);
      let release: SemaphoreRelease | undefined;

      const publish = (next: SubagentDetailsV1) => {
        details = next;
        try {
          onUpdate?.({
            content: [{ type: "text", text: lifecycleText(next) }],
            details: next,
          });
        } catch {
          // A presentation callback must not change process or persistence semantics.
        }
      };

      const settleSetupFailure = (status: Extract<SubagentStatus, "failed" | "cancelled">, message: string) => {
        details = appendSubagentActivity(
          details,
          { timestamp: now(), kind: "diagnostic", title: truncateUtf8(message, 512).content, isError: true },
          now(),
        );
        publish(createTerminalSubagentDetails(details, { status, error: truncateUtf8(message, ERROR_PREVIEW_BYTES).content }, now()));
      };

      try {
        let cwd: string;
        try {
          cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
        } catch (error) {
          settleSetupFailure("failed", errorMessage(error));
          throw error;
        }
        details = updateSubagentDetails(details, { cwd }, now());
        details = appendSubagentActivity(
          details,
          { timestamp: now(), kind: "diagnostic", title: "Queued for a child Pi process" },
          now(),
        );
        publish(details);

        let agentPrompt: string;
        try {
          agentPrompt = await fs.promises.readFile(agent.promptPath, "utf8");
        } catch (error) {
          settleSetupFailure("failed", `Unable to load the ${agentName} preset: ${errorMessage(error)}`);
          throw error;
        }

        try {
          release = await semaphore.acquire(combinedSignal);
        } catch (error) {
          settleSetupFailure("cancelled", "Subagent was cancelled while queued.");
          throw error;
        }
        if (combinedSignal.aborted) {
          settleSetupFailure("cancelled", "Subagent was cancelled before it started.");
          throw new Error("Subagent was cancelled before it started.");
        }

        const startedAt = now();
        details = updateSubagentDetails(
          details,
          { status: "starting", phase: "spawning", startedAt },
          startedAt,
        );
        details = appendSubagentActivity(
          details,
          { timestamp: startedAt, kind: "diagnostic", title: "Starting child Pi" },
          startedAt,
        );
        publish(details);

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
        args.push(agent.promptFlag, agentPrompt, params.prompt);
        const invocation = resolveInvocation(args);
        const execution = await run({
          details,
          command: invocation.command,
          args: invocation.args,
          cwd,
          timeoutMs: agent.timeoutMs,
          signal: combinedSignal,
          onSnapshot: publish,
        });
        details = execution.details;

        if (details.run.status !== "succeeded") {
          if (!shuttingDown) failedDetails.set(toolCallId, details);
          throw new Error(details.run.error || `Subagent ${details.run.status}.`);
        }

        const visibleOutput = execution.output || "(no output)";
        const truncation = truncateHead(visibleOutput, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        const fullOutputPath = truncation.truncated ? await saveFullOutput(visibleOutput) : undefined;
        let resultText = truncation.content;
        if (truncation.truncated) {
          resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
          if (fullOutputPath) resultText += ` Full output saved to: ${fullOutputPath}`;
          resultText += "]";
        }
        details = updateSubagentDetails(
          details,
          {
            outputPreview: truncateUtf8(visibleOutput, 4 * 1024).content,
            ...(fullOutputPath ? { fullOutputPath } : {}),
          },
          now(),
        );

        return {
          content: [{ type: "text", text: resultText }],
          details,
        };
      } catch (error) {
        if (!isTerminalSubagentStatus(details.run.status)) {
          const cancelled = combinedSignal.aborted;
          settleSetupFailure(cancelled ? "cancelled" : "failed", errorMessage(error));
        }
        if (!shuttingDown) failedDetails.set(toolCallId, details);
        throw new Error(details.run.error || errorMessage(error), { cause: error });
      } finally {
        release?.();
      }
    },

    renderCall(args, theme, context) {
      const agent = typeof args.agent === "string" ? args.agent : context.argsComplete ? DEFAULT_AGENT_NAME : "...";
      const prompt = typeof args.prompt === "string" ? args.prompt : "...";
      const preview = truncateUtf8(prompt.replace(/\s+/g, " "), 160).content;
      let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agent)}`;
      if (typeof args.cwd === "string") text += theme.fg("muted", ` in ${args.cwd}`);
      text += `\n${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      if (!isSubagentDetailsV1(result.details)) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
      }

      const details = result.details;
      const { run } = details;
      const iconColor = run.status === "succeeded" ? "success" : isTerminalSubagentStatus(run.status) ? "error" : "warning";
      let text = `${theme.fg(iconColor, statusIcon(run.status))} ${theme.fg("toolTitle", run.agent)}`;
      text += theme.fg("dim", ` · ${run.model} · ${run.status}`);
      const usage = formatUsage(details);
      if (usage) text += `\n${theme.fg("dim", usage)}`;

      if (expanded && run.recentActivity.length) {
        text += `\n${run.recentActivity.map((item) => theme.fg(item.isError ? "error" : "muted", item.title)).join("\n")}`;
      }
      if (run.error) text += `\n\n${theme.fg("error", run.error)}`;
      const content = result.content.find((item) => item.type === "text");
      if (content?.type === "text" && expanded && !context.isError) {
        text += `\n\n${theme.fg("toolOutput", content.text)}`;
      }
      if (run.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${run.fullOutputPath}`)}`;
      return new Text(text, 0, 0);
    },
  });
}

export default function subagentExtension(pi: ExtensionAPI): void {
  registerSubagentExtension(pi);
}
