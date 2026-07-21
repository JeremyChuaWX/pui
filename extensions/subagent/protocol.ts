export const SUBAGENT_SCHEMA = "pi.subagent" as const;
export const SUBAGENT_PROTOCOL_VERSION = 1 as const;
export const MAX_RECENT_ACTIVITY = 20;

export type SubagentStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SubagentPhase = "queued" | "spawning" | "thinking" | "tool" | "exiting";
export type SubagentActivityKind = "turn" | "tool_start" | "tool_end" | "assistant" | "diagnostic";
export type SubagentTerminalStatus = Extract<SubagentStatus, "succeeded" | "failed" | "cancelled" | "timed_out">;

export interface SubagentActiveToolV1 {
  id: string;
  name: string;
  title: string;
  startedAt: number;
}

export interface SubagentActivityV1 {
  sequence: number;
  timestamp: number;
  kind: SubagentActivityKind;
  title: string;
  isError?: boolean;
}

export interface SubagentUsageV1 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface SubagentRunV1 {
  id: string;
  agent: string;
  model: string;
  cwd: string;
  status: SubagentStatus;
  phase?: SubagentPhase;
  startedAt?: number;
  updatedAt: number;
  endedAt?: number;
  activeTools: SubagentActiveToolV1[];
  recentActivity: SubagentActivityV1[];
  usage: SubagentUsageV1;
  outputPreview?: string;
  error?: string;
  fullOutputPath?: string;
}

export interface SubagentDetailsV1 {
  schema: typeof SUBAGENT_SCHEMA;
  version: typeof SUBAGENT_PROTOCOL_VERSION;
  run: SubagentRunV1;
}

export interface CreateSubagentDetailsInput {
  id: string;
  agent: string;
  model: string;
  cwd: string;
  now?: number;
}

export type SubagentRunPatch = Partial<
  Omit<SubagentRunV1, "id" | "updatedAt" | "activeTools" | "recentActivity" | "usage">
> & {
  activeTools?: SubagentActiveToolV1[];
  recentActivity?: SubagentActivityV1[];
  usage?: SubagentUsageV1;
};

export interface SubagentTerminalPatch {
  status: SubagentTerminalStatus;
  error?: string;
  outputPreview?: string;
  fullOutputPath?: string;
  model?: string;
}

export interface Utf8Truncation {
  content: string;
  truncated: boolean;
  outputBytes: number;
  totalBytes: number;
}

const STATUSES = new Set<SubagentStatus>([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
const TERMINAL_STATUSES = new Set<SubagentStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
const PHASES = new Set<SubagentPhase>(["queued", "spawning", "thinking", "tool", "exiting"]);
const ACTIVITY_KINDS = new Set<SubagentActivityKind>([
  "turn",
  "tool_start",
  "tool_end",
  "assistant",
  "diagnostic",
]);

export function emptySubagentUsage(): SubagentUsageV1 {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
  };
}

export function isTerminalSubagentStatus(status: SubagentStatus): status is SubagentTerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

export function createInitialSubagentDetails(input: CreateSubagentDetailsInput): SubagentDetailsV1 {
  const now = input.now ?? Date.now();
  return {
    schema: SUBAGENT_SCHEMA,
    version: SUBAGENT_PROTOCOL_VERSION,
    run: {
      id: input.id,
      agent: input.agent,
      model: input.model,
      cwd: input.cwd,
      status: "queued",
      phase: "queued",
      updatedAt: now,
      activeTools: [],
      recentActivity: [],
      usage: emptySubagentUsage(),
    },
  };
}

export function updateSubagentDetails(
  details: SubagentDetailsV1,
  patch: SubagentRunPatch,
  now = Date.now(),
): SubagentDetailsV1 {
  const status = patch.status ?? details.run.status;
  const terminal = isTerminalSubagentStatus(status);
  const run: SubagentRunV1 = {
    ...details.run,
    ...patch,
    id: details.run.id,
    status,
    updatedAt: now,
    activeTools: terminal ? [] : [...(patch.activeTools ?? details.run.activeTools)],
    recentActivity: [...(patch.recentActivity ?? details.run.recentActivity)].slice(-MAX_RECENT_ACTIVITY),
    usage: { ...(patch.usage ?? details.run.usage) },
  };

  if (terminal) {
    run.phase = "exiting";
    run.endedAt = patch.endedAt ?? details.run.endedAt ?? now;
  } else {
    delete run.endedAt;
  }

  return { schema: SUBAGENT_SCHEMA, version: SUBAGENT_PROTOCOL_VERSION, run };
}

export function createTerminalSubagentDetails(
  details: SubagentDetailsV1,
  patch: SubagentTerminalPatch,
  now = Date.now(),
): SubagentDetailsV1 {
  return updateSubagentDetails(
    details,
    {
      ...patch,
      phase: "exiting",
      endedAt: now,
      activeTools: [],
    },
    now,
  );
}

export function appendSubagentActivity(
  details: SubagentDetailsV1,
  activity: Omit<SubagentActivityV1, "sequence"> & { sequence?: number },
  now = activity.timestamp,
): SubagentDetailsV1 {
  const previous = details.run.recentActivity.at(-1)?.sequence ?? 0;
  const sequence = Math.max(previous + 1, activity.sequence ?? 0);
  const next: SubagentActivityV1 = { ...activity, sequence };
  return updateSubagentDetails(
    details,
    { recentActivity: [...details.run.recentActivity, next].slice(-MAX_RECENT_ACTIVITY) },
    now,
  );
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageField(usage: unknown, field: string): number {
  if (typeof usage !== "object" || usage === null) return 0;
  return nonNegativeNumber((usage as Record<string, unknown>)[field]);
}

function usageCost(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const cost = (usage as Record<string, unknown>).cost;
  if (typeof cost === "number") return nonNegativeNumber(cost);
  if (typeof cost === "object" && cost !== null) return nonNegativeNumber((cost as Record<string, unknown>).total);
  return 0;
}

/** Aggregate one finalized assistant message. Missing and non-finite fields count as zero. */
export function aggregateSubagentUsage(
  current: SubagentUsageV1,
  assistantUsage: unknown,
  turns = 1,
): SubagentUsageV1 {
  const input = usageField(assistantUsage, "input");
  const output = usageField(assistantUsage, "output");
  const cacheRead = usageField(assistantUsage, "cacheRead");
  const cacheWrite = usageField(assistantUsage, "cacheWrite");
  const reportedTotal = usageField(assistantUsage, "totalTokens");
  return {
    input: current.input + input,
    output: current.output + output,
    cacheRead: current.cacheRead + cacheRead,
    cacheWrite: current.cacheWrite + cacheWrite,
    totalTokens: current.totalTokens + (reportedTotal || input + output + cacheRead + cacheWrite),
    cost: current.cost + usageCost(assistantUsage),
    turns: current.turns + Math.max(0, Math.floor(nonNegativeNumber(turns))),
  };
}

function truncateUtf8Direction(text: string, maxBytes: number, tail: boolean): Utf8Truncation {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const cap = Math.max(0, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 0));
  if (totalBytes <= cap) return { content: text, truncated: false, outputBytes: totalBytes, totalBytes };
  if (cap === 0) return { content: "", truncated: true, outputBytes: 0, totalBytes };

  const characters = Array.from(text);
  const kept: string[] = [];
  let outputBytes = 0;
  if (tail) characters.reverse();
  for (const character of characters) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (outputBytes + bytes > cap) break;
    kept.push(character);
    outputBytes += bytes;
  }
  if (tail) kept.reverse();
  return { content: kept.join(""), truncated: true, outputBytes, totalBytes };
}

/** Truncate at a Unicode code-point boundary, retaining the beginning of the text. */
export function truncateUtf8(text: string, maxBytes: number): Utf8Truncation {
  return truncateUtf8Direction(text, maxBytes, false);
}

/** Truncate at a Unicode code-point boundary, retaining the end of the text. */
export function truncateUtf8Tail(text: string, maxBytes: number): Utf8Truncation {
  return truncateUtf8Direction(text, maxBytes, true);
}

/** Append text while retaining at most maxBytes of the newest valid UTF-8 content. */
export function appendBoundedUtf8(current: string, addition: string, maxBytes: number): string {
  return truncateUtf8Tail(current + addition, maxBytes).content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isSubagentDetailsV1(value: unknown): value is SubagentDetailsV1 {
  if (!isRecord(value) || value.schema !== SUBAGENT_SCHEMA || value.version !== SUBAGENT_PROTOCOL_VERSION) return false;
  const run = value.run;
  if (!isRecord(run)) return false;
  if (
    typeof run.id !== "string" ||
    typeof run.agent !== "string" ||
    typeof run.model !== "string" ||
    typeof run.cwd !== "string" ||
    typeof run.status !== "string" ||
    !STATUSES.has(run.status as SubagentStatus) ||
    !isFiniteNonNegative(run.updatedAt)
  ) {
    return false;
  }
  if (run.phase !== undefined && (typeof run.phase !== "string" || !PHASES.has(run.phase as SubagentPhase))) return false;
  if (run.startedAt !== undefined && !isFiniteNonNegative(run.startedAt)) return false;
  if (run.endedAt !== undefined && !isFiniteNonNegative(run.endedAt)) return false;
  if (isTerminalSubagentStatus(run.status as SubagentStatus) && run.endedAt === undefined) return false;
  if (!Array.isArray(run.activeTools) || !Array.isArray(run.recentActivity) || run.recentActivity.length > MAX_RECENT_ACTIVITY) {
    return false;
  }
  if (isTerminalSubagentStatus(run.status as SubagentStatus) && run.activeTools.length > 0) return false;
  for (const tool of run.activeTools) {
    if (
      !isRecord(tool) ||
      typeof tool.id !== "string" ||
      typeof tool.name !== "string" ||
      typeof tool.title !== "string" ||
      !isFiniteNonNegative(tool.startedAt)
    ) {
      return false;
    }
  }
  let previousSequence = -1;
  for (const activity of run.recentActivity) {
    if (
      !isRecord(activity) ||
      !Number.isInteger(activity.sequence) ||
      (activity.sequence as number) <= previousSequence ||
      !isFiniteNonNegative(activity.timestamp) ||
      typeof activity.kind !== "string" ||
      !ACTIVITY_KINDS.has(activity.kind as SubagentActivityKind) ||
      typeof activity.title !== "string" ||
      (activity.isError !== undefined && typeof activity.isError !== "boolean")
    ) {
      return false;
    }
    previousSequence = activity.sequence as number;
  }
  if (!isRecord(run.usage)) return false;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "turns"] as const) {
    if (!isFiniteNonNegative(run.usage[field])) return false;
  }
  for (const field of ["outputPreview", "error", "fullOutputPath"] as const) {
    if (run[field] !== undefined && typeof run[field] !== "string") return false;
  }
  return true;
}
