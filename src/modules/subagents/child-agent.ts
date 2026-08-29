import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createGracefulTermination, killProcessTree } from "#shared/lib/bounded-process.js";
import { type Clock, SYSTEM_CLOCK } from "#shared/lib/clock.js";
import { appendBoundedUtf8, truncateUtf8 } from "#shared/lib/retained-output.js";
import { errorMessage, isRecord } from "#shared/lib/validate.js";
import { JsonLineParser } from "./json-events.js";
import { describeLimit, type JobLimits } from "./profiles/profile.js";
import { AbortableSemaphore, configuredSubagentConcurrency } from "./semaphore.js";

const DEFAULT_THROTTLE_MS = 75;
const DEFAULT_KILL_GRACE_MS = 2_000;
const STDERR_CAP_BYTES = 16 * 1024;
const DIAGNOSTIC_CAP_BYTES = 8 * 1024;
const OUTPUT_PREVIEW_BYTES = 4 * 1024;
const EVENT_TITLE_BYTES = 512;
const ASSISTANT_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

const processState = globalThis as typeof globalThis & {
    __piSubagentSemaphoreV1?: AbortableSemaphore;
};
/** The one process-wide child-Pi concurrency slot, shared across every extension instance in this process. */
export const PROCESS_CHILD_AGENT_SEMAPHORE: AbortableSemaphore =
    processState.__piSubagentSemaphoreV1 ?? new AbortableSemaphore(configuredSubagentConcurrency());
if (!processState.__piSubagentSemaphoreV1) processState.__piSubagentSemaphoreV1 = PROCESS_CHILD_AGENT_SEMAPHORE;

export interface ChildAgentUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    turns: number;
}

export function emptyChildAgentUsage(): ChildAgentUsage {
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
export function aggregateChildAgentUsage(
    current: ChildAgentUsage,
    assistantUsage: unknown,
    turns = 1,
): ChildAgentUsage {
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

/** Resolve a stable, canonical model label from a child assistant event. */
function resolveChildAgentModelLabel(current: string, provider?: string, model?: string): string {
    const childProvider = provider?.trim();
    const childModel = model?.trim();
    if (!childProvider || !childModel) return current;

    const reportedSuffix = childModel.match(THINKING_SUFFIX)?.[0] ?? "";
    const reportedBase = reportedSuffix ? childModel.slice(0, -reportedSuffix.length) : childModel;
    const canonicalBase = reportedBase.startsWith(`${childProvider}/`)
        ? reportedBase
        : `${childProvider}/${reportedBase}`;
    const currentSuffix = current.match(THINKING_SUFFIX)?.[0] ?? "";
    const currentBase = currentSuffix ? current.slice(0, -currentSuffix.length) : current;
    return `${canonicalBase}${currentBase === canonicalBase ? currentSuffix || reportedSuffix : reportedSuffix}`;
}

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;
export type SpawnChildAgent = (
    command: string,
    args: readonly string[],
    options: {
        cwd: string;
        shell: false;
        detached: boolean;
        stdio: ["ignore", "pipe", "pipe"];
    },
) => SpawnedChild;

type ChildAgentPhase = "thinking" | "tool" | "exiting";

interface ChildAgentTool {
    id: string;
    name: string;
    title: string;
    startedAt: number;
}

/** One notable moment in a child agent's lifetime, phrased without any wire protocol's vocabulary. */
export type ChildAgentEvent =
    | { kind: "spawned"; timestamp: number }
    | { kind: "turn" | "tool_start"; timestamp: number; title: string }
    | { kind: "tool_end" | "assistant" | "diagnostic"; timestamp: number; title: string; isError: boolean };

/** The runtime's rolling view of the child, delivered with every event flush. */
export interface ChildAgentState {
    phase: ChildAgentPhase;
    activeTools: ChildAgentTool[];
    model: string;
    usage: ChildAgentUsage;
    /** Last non-empty assistant text, preview-bounded; empty until the child produces text. */
    outputPreview: string;
    /** Timestamp of the newest folded child event. */
    updatedAt: number;
}

/** `timed_out`, `stalled`, and `tool_stalled` are the wall clock, stall, and tool-stall Limits respectively. */
export type ChildAgentTerminalStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "stalled" | "tool_stalled";

/** Why the runtime stopped the child before it exited on its own. */
interface Termination {
    status: Extract<ChildAgentTerminalStatus, "cancelled" | "timed_out" | "stalled" | "tool_stalled">;
    /** Short activity title, shown in the Job's recent activity. */
    title: string;
    /** First line of the terminal error. */
    message: string;
}

export interface ChildAgentResult {
    status: ChildAgentTerminalStatus;
    error?: string;
    /** Text of the final assistant message; empty when the child never finalized one. */
    output: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    model: string;
    usage: ChildAgentUsage;
    /** Preview-bounded final output; empty when there was none. */
    outputPreview: string;
}

export interface RunChildAgentOptions {
    command: string;
    args: string[];
    cwd: string;
    /** The three Limits the child runs under. */
    limits: JobLimits;
    /** Initial model label, canonicalized as the child reports its provider and model. */
    model: string;
    /** Usage seed for details that already carry aggregated usage. */
    usage?: ChildAgentUsage;
    signal?: AbortSignal;
    /**
     * Receives batched events with the folded state. Flushes are throttled except at spawn, tool
     * boundaries, and termination; the tail of the stream always flushes before the run resolves.
     */
    onFlush?: (events: ChildAgentEvent[], state: ChildAgentState) => void;
    throttleMs?: number;
    killGraceMs?: number;
    /** Time source and timer scheduler for the throttle, the Limits, and the SIGKILL grace. */
    clock?: Clock;
    spawn?: SpawnChildAgent;
}

interface JsonEvent {
    type: string;
    [key: string]: unknown;
}

function isJsonEvent(value: unknown): value is JsonEvent {
    return isRecord(value) && typeof value.type === "string";
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function assistantText(message: unknown): string {
    if (!isRecord(message) || !Array.isArray(message.content)) return "";
    return message.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function shorten(value: unknown, fallback = "..."): string {
    const text = typeof value === "string" ? value : fallback;
    return truncateUtf8(text.replace(/\s+/g, " ").trim() || fallback, 240).content;
}

function compactToolTitle(toolName: string, input: unknown): string {
    const args = isRecord(input) ? input : {};
    let title: string;
    if (toolName === "read") title = `read ${shorten(args.path ?? args.file_path)}`;
    else if (toolName === "grep") title = `grep ${shorten(args.pattern)} in ${shorten(args.path, ".")}`;
    else if (toolName === "find") title = `find ${shorten(args.pattern, "*")} in ${shorten(args.path, ".")}`;
    else if (toolName === "ls") title = `ls ${shorten(args.path, ".")}`;
    else if (toolName === "bash") title = `$ ${shorten(args.command)}`;
    else if (toolName === "edit") title = `edit ${shorten(args.path ?? args.file_path)}`;
    else if (toolName === "write") title = `write ${shorten(args.path ?? args.file_path)}`;
    else title = toolName;
    return truncateUtf8(title, EVENT_TITLE_BYTES).content;
}

export function getPiInvocation(
    args: string[],
    currentScript = process.argv[1],
    execPath = process.execPath,
): { command: string; args: string[] } {
    // Reuse argv[1] only when the host is Pi's own CLI. Other scripts and
    // compiled hosts (including pui) cannot parse Pi CLI flags.
    let resolvedScript: string | undefined;
    if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
        try {
            resolvedScript = fs.realpathSync(currentScript);
        } catch {
            resolvedScript = currentScript;
        }
    }
    const packageSegment = `${path.sep}@earendil-works${path.sep}pi-coding-agent${path.sep}`;
    const isPiCli =
        resolvedScript?.includes(packageSegment) === true && path.basename(resolvedScript).toLowerCase() === "cli.js";
    if (isPiCli && currentScript) return { command: execPath, args: [currentScript, ...args] };

    const execName = path.basename(execPath).toLowerCase();
    const isPiExecutable = /^pi(\.exe)?$/.test(execName);
    return isPiExecutable ? { command: execPath, args } : { command: "pi", args };
}

function messageFingerprint(message: Record<string, unknown>): string {
    const usage = isRecord(message.usage) ? message.usage : {};
    return [
        String(message.timestamp ?? ""),
        String(message.provider ?? ""),
        String(message.model ?? ""),
        String(message.stopReason ?? ""),
        String(usage.input ?? ""),
        String(usage.output ?? ""),
    ].join(":");
}

function boundedDiagnostic(prefix: string, candidate: string): string {
    const diagnostic = truncateUtf8(candidate.trim(), DIAGNOSTIC_CAP_BYTES).content;
    return diagnostic ? `${prefix}\n\n${diagnostic}` : prefix;
}

function phaseFor(activeToolCount: number): Extract<ChildAgentPhase, "thinking" | "tool"> {
    return activeToolCount > 0 ? "tool" : "thinking";
}

function spawnDefault(
    command: string,
    args: readonly string[],
    options: { cwd: string; shell: false; detached: boolean; stdio: ["ignore", "pipe", "pipe"] },
): SpawnedChild {
    return nodeSpawn(command, [...args], options);
}

/**
 * Run one child Pi process and always resolve to a structured terminal result. Owns the three
 * Limits (wall clock, stall, tool stall) and SIGTERM-to-SIGKILL escalation over the process tree.
 * The caller decides whether a failed terminal result should be thrown, and folds the event
 * stream into its own protocol's shape.
 */
export async function runChildAgent(options: RunChildAgentOptions): Promise<ChildAgentResult> {
    const clock = options.clock ?? SYSTEM_CLOCK;
    const now = () => clock.now();
    const limits = options.limits;
    const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS);
    const killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    const spawnChild = options.spawn ?? spawnDefault;
    const activeTools = new Map<string, ChildAgentTool>();
    const state: ChildAgentState = {
        phase: "thinking",
        activeTools: [],
        model: options.model,
        usage: options.usage ? { ...options.usage } : emptyChildAgentUsage(),
        outputPreview: "",
        updatedAt: now(),
    };
    let child: SpawnedChild | undefined;
    let stderr = "";
    let diagnostics = "";
    let finalMessage: AssistantMessage | undefined;
    let finalOutput = "";
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;
    let termination: Termination | undefined;
    let settled = false;
    let closed = false;
    let dirty = false;
    let updateTimer: unknown;
    let wallClockTimer: unknown;
    let stallTimer: unknown;
    /** Clock time of the newest child event; the stall Limits count from here. */
    let lastActivityAt = now();
    let lastFlush = Number.NEGATIVE_INFINITY;
    let pendingEvents: ChildAgentEvent[] = [];
    const finalizedMessages = new Set<string>();

    const flush = (force = false) => {
        if (settled && !force) return;
        if (!options.onFlush) {
            pendingEvents = [];
            dirty = false;
            return;
        }
        const wait = throttleMs - (now() - lastFlush);
        if (!force && wait > 0) {
            if (updateTimer === undefined)
                updateTimer = clock.setTimeout(() => {
                    updateTimer = undefined;
                    flush(true);
                }, wait);
            return;
        }
        if (updateTimer !== undefined) clock.clearTimeout(updateTimer);
        updateTimer = undefined;
        lastFlush = now();
        const events = pendingEvents;
        pendingEvents = [];
        dirty = false;
        try {
            options.onFlush(events, { ...state, activeTools: [...activeTools.values()] });
        } catch {
            // Adapter progress must never be able to strand the child process.
        }
    };

    /**
     * Record child activity. The child's own timestamp feeds the state; the stall Limits count
     * from this process's clock, so a child cannot postpone them by reporting future times.
     */
    const touch = (timestamp: number) => {
        state.updatedAt = timestamp;
        dirty = true;
        lastActivityAt = now();
        armStallTimer();
    };

    /** The stall Limit that applies right now: tool stall while a tool is active, stall otherwise. */
    const activeStallLimit = () =>
        activeTools.size > 0
            ? { status: "tool_stalled" as const, name: "tool stall", ms: limits.toolStallTimeoutMs }
            : { status: "stalled" as const, name: "stall", ms: limits.stallTimeoutMs };

    /** Re-arm the one stall timer for the Limit that applies, measured from the newest activity. */
    function armStallTimer(): void {
        if (stallTimer !== undefined) clock.clearTimeout(stallTimer);
        stallTimer = undefined;
        if (!child || closed || settled || termination) return;
        const limit = activeStallLimit();
        if (limit.ms <= 0) return;
        const remaining = limit.ms - (now() - lastActivityAt);
        if (remaining > 0) {
            stallTimer = clock.setTimeout(armStallTimer, remaining);
            return;
        }
        const label = describeLimit(limit.ms);
        terminate({
            status: limit.status,
            title: `${limit.name === "stall" ? "Stall" : "Tool stall"} limit reached`,
            message:
                limit.status === "tool_stalled"
                    ? `Subagent's active tool produced no output for ${label} (tool stall limit).`
                    : `Subagent produced no events for ${label} while no tool was active (stall limit).`,
        });
    }

    const pushEvent = (event: ChildAgentEvent, force = false) => {
        pendingEvents.push(
            "title" in event ? { ...event, title: truncateUtf8(event.title, EVENT_TITLE_BYTES).content } : event,
        );
        dirty = true;
        flush(force);
    };

    const addDiagnostic = (message: string, isError = true) => {
        const bounded = truncateUtf8(message, EVENT_TITLE_BYTES).content;
        diagnostics = appendBoundedUtf8(diagnostics, `${diagnostics ? "\n" : ""}${bounded}`, DIAGNOSTIC_CAP_BYTES);
        const timestamp = now();
        touch(timestamp);
        pushEvent({ kind: "diagnostic", timestamp, title: bounded, isError });
    };

    type EventHandler = (event: JsonEvent, timestamp: number) => void;
    const turnHandler =
        (label: "started" | "completed"): EventHandler =>
        (event, timestamp) => {
            const index = numberOrUndefined(event.turnIndex);
            state.phase = phaseFor(activeTools.size);
            touch(timestamp);
            pushEvent({
                kind: "turn",
                timestamp,
                title: index === undefined ? `Turn ${label}` : `Turn ${index + 1} ${label}`,
            });
        };
    const exitingHandler: EventHandler = (_event, timestamp) => {
        state.phase = "exiting";
        touch(timestamp);
        flush();
    };
    const dispatch: Record<string, EventHandler> = {
        turn_start: turnHandler("started"),
        turn_end: turnHandler("completed"),
        tool_execution_start: (event, timestamp) => {
            const id = stringOrUndefined(event.toolCallId);
            const name = stringOrUndefined(event.toolName);
            if (!id || !name) {
                addDiagnostic("Child emitted an invalid tool_execution_start event.");
                return;
            }
            const title = compactToolTitle(name, event.args);
            activeTools.set(id, { id, name, title, startedAt: timestamp });
            state.phase = "tool";
            touch(timestamp);
            pushEvent({ kind: "tool_start", timestamp, title }, true);
        },
        tool_execution_update: (event, timestamp) => {
            const id = stringOrUndefined(event.toolCallId);
            const active = id ? activeTools.get(id) : undefined;
            if (!id || !active) return;
            activeTools.set(id, { ...active, title: compactToolTitle(active.name, event.args) });
            state.phase = "tool";
            touch(timestamp);
            flush();
        },
        tool_execution_end: (event, timestamp) => {
            const id = stringOrUndefined(event.toolCallId);
            const name = stringOrUndefined(event.toolName) ?? "tool";
            const active = id ? activeTools.get(id) : undefined;
            const title = active?.title ?? compactToolTitle(name, undefined);
            if (id) activeTools.delete(id);
            state.phase = phaseFor(activeTools.size);
            touch(timestamp);
            pushEvent({ kind: "tool_end", timestamp, title, isError: event.isError === true }, true);
        },
        message_update: (event, timestamp) => {
            if (!isRecord(event.message) || event.message.role !== "assistant") return;
            const preview = assistantText(event.message);
            if (preview) state.outputPreview = truncateUtf8(preview, OUTPUT_PREVIEW_BYTES).content;
            state.model = resolveChildAgentModelLabel(
                state.model,
                stringOrUndefined(event.message.provider),
                stringOrUndefined(event.message.model),
            );
            state.phase = phaseFor(activeTools.size);
            touch(timestamp);
            flush();
        },
        message_end: (event, timestamp) => {
            if (!isRecord(event.message) || event.message.role !== "assistant") return;
            if (
                !Array.isArray(event.message.content) ||
                typeof event.message.stopReason !== "string" ||
                !ASSISTANT_STOP_REASONS.has(event.message.stopReason)
            ) {
                addDiagnostic("Child emitted an invalid finalized assistant message.");
                return;
            }
            const message = event.message as unknown as AssistantMessage;
            finalMessage = message;
            finalOutput = assistantText(message);
            const fingerprint = messageFingerprint(event.message);
            if (!finalizedMessages.has(fingerprint)) {
                finalizedMessages.add(fingerprint);
                state.usage = aggregateChildAgentUsage(state.usage, event.message.usage);
            }
            state.model = resolveChildAgentModelLabel(
                state.model,
                stringOrUndefined(event.message.provider),
                stringOrUndefined(event.message.model),
            );
            const preview = truncateUtf8(finalOutput, OUTPUT_PREVIEW_BYTES).content;
            if (preview) state.outputPreview = preview;
            const stopReason = stringOrUndefined(event.message.stopReason);
            const title = preview
                ? `Assistant: ${shorten(preview, "response")}`
                : stopReason === "toolUse"
                  ? "Assistant requested tools"
                  : "Assistant response completed";
            state.phase = phaseFor(activeTools.size);
            touch(timestamp);
            pushEvent({
                kind: "assistant",
                timestamp,
                title,
                isError: stopReason === "error" || stopReason === "aborted",
            });
        },
        agent_end: exitingHandler,
        agent_settled: exitingHandler,
    };

    const processEvent = (eventValue: unknown) => {
        if (settled || !isJsonEvent(eventValue)) return;
        if (!Object.hasOwn(dispatch, eventValue.type)) return;
        dispatch[eventValue.type]?.(eventValue, numberOrUndefined(eventValue.timestamp) ?? now());
    };

    const parser = new JsonLineParser({
        onValue: processEvent,
        onDiagnostic: (message) => addDiagnostic(message),
    });

    const sendSignal = (signal: NodeJS.Signals) => {
        if (!child || closed) return;
        killProcessTree(child, signal);
    };
    const terminator = createGracefulTermination(sendSignal, { graceMs: killGraceMs, timers: clock });

    function terminate(next: Termination): void {
        if (settled || closed || termination) return;
        termination = next;
        const timestamp = now();
        state.phase = "exiting";
        touch(timestamp);
        pushEvent({ kind: "diagnostic", timestamp, title: next.title, isError: true }, true);
        terminator.begin();
    }

    const abortListener = () =>
        terminate({ status: "cancelled", title: "Cancellation requested", message: "Subagent was cancelled." });

    const clearTimers = () => {
        for (const handle of [wallClockTimer, stallTimer, updateTimer]) {
            if (handle !== undefined) clock.clearTimeout(handle);
        }
        wallClockTimer = undefined;
        stallTimer = undefined;
        updateTimer = undefined;
    };

    const finalize = (): ChildAgentResult => {
        terminator.dispose();
        if (options.signal) options.signal.removeEventListener("abort", abortListener);
        if (dirty) flush(true);
        clearTimers();
        settled = true;

        const stopReason = finalMessage?.stopReason;
        const stderrOrDiagnostic = stderr.trim() || diagnostics.trim();
        const outputOrDiagnostic = finalOutput.trim() || stderrOrDiagnostic;
        let status: ChildAgentTerminalStatus;
        let error: string | undefined;

        if (termination) {
            status = termination.status;
            error = boundedDiagnostic(termination.message, outputOrDiagnostic);
        } else if (spawnError) {
            status = "failed";
            error = boundedDiagnostic(`Unable to start child Pi: ${spawnError.message}`, stderrOrDiagnostic);
        } else if (exitCode !== 0) {
            status = "failed";
            error = boundedDiagnostic(`Subagent failed with exit code ${exitCode ?? "unknown"}.`, outputOrDiagnostic);
        } else if (!finalMessage || finalMessage.stopReason === "toolUse") {
            status = "failed";
            error = boundedDiagnostic(
                "Subagent exited without a final assistant response.",
                stderrOrDiagnostic || diagnostics,
            );
        } else if (stopReason === "aborted") {
            status = "failed";
            error = boundedDiagnostic(
                finalMessage.errorMessage || "Child assistant stopped unexpectedly.",
                outputOrDiagnostic,
            );
        } else if (stopReason === "error") {
            status = "failed";
            error = boundedDiagnostic(
                finalMessage.errorMessage || "Subagent model request failed.",
                outputOrDiagnostic,
            );
        } else {
            status = "succeeded";
        }

        if (child) {
            child.stdout.removeAllListeners();
            child.stderr.removeAllListeners();
            child.removeAllListeners();
        }
        return {
            status,
            ...(error ? { error } : {}),
            output: finalOutput,
            stderr,
            exitCode,
            signal: exitSignal,
            model: finalMessage
                ? resolveChildAgentModelLabel(state.model, finalMessage.provider, finalMessage.model)
                : state.model,
            usage: state.usage,
            outputPreview: truncateUtf8(finalOutput, OUTPUT_PREVIEW_BYTES).content,
        };
    };

    if (options.signal?.aborted) {
        termination = { status: "cancelled", title: "Cancellation requested", message: "Subagent was cancelled." };
        return finalize();
    }

    try {
        child = spawnChild(options.command, options.args, {
            cwd: options.cwd,
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        spawnError = error instanceof Error ? error : new Error(String(error));
        return finalize();
    }

    if (!child) {
        spawnError = new Error("Subagent process did not start.");
        return finalize();
    }
    const runningChild = child;

    const startedAt = now();
    state.phase = "thinking";
    touch(startedAt);
    pushEvent({ kind: "spawned", timestamp: startedAt }, true);

    return new Promise<ChildAgentResult>((resolve) => {
        runningChild.stdout.on("data", (chunk: Buffer | string) => {
            try {
                parser.write(chunk);
            } catch (error) {
                addDiagnostic(`Unable to process child output: ${errorMessage(error)}`);
            }
        });
        runningChild.stdout.on("error", (error) => addDiagnostic(`Child stdout failed: ${error.message}`));
        runningChild.stderr.on("data", (chunk: Buffer | string) => {
            stderr = appendBoundedUtf8(stderr, chunk.toString(), STDERR_CAP_BYTES);
        });
        runningChild.stderr.on("error", (error) => {
            stderr = appendBoundedUtf8(stderr, `\nChild stderr failed: ${error.message}`, STDERR_CAP_BYTES);
        });
        runningChild.on("error", (error) => {
            spawnError = error;
        });
        runningChild.on("close", (code, signal) => {
            // The direct Pi process can exit after SIGTERM while a tool subprocess in
            // its detached process group ignores it. Escalate the group before clearing
            // the grace timer so cancellation never leaves a descendant behind.
            terminator.escalateOnClose();
            closed = true;
            exitCode = code;
            exitSignal = signal;
            parser.end();
            resolve(finalize());
        });

        if (options.signal) options.signal.addEventListener("abort", abortListener, { once: true });
        if (limits.wallClockMs > 0) {
            wallClockTimer = clock.setTimeout(
                () =>
                    terminate({
                        status: "timed_out",
                        title: "Wall clock limit reached",
                        message: `Subagent reached its ${describeLimit(limits.wallClockMs)} wall clock limit.`,
                    }),
                limits.wallClockMs,
            );
        }
        lastActivityAt = startedAt;
        armStallTimer();
        if (options.signal?.aborted) abortListener();
    });
}
