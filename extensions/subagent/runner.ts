import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { JsonLineParser } from "./json-events.js";
import {
    aggregateSubagentUsage,
    appendBoundedUtf8,
    appendSubagentActivity,
    createTerminalSubagentDetails,
    isSubagentDetailsV1,
    type SubagentActiveToolV1,
    type SubagentDetailsV1,
    type SubagentTerminalStatus,
    truncateUtf8,
    updateSubagentDetails,
} from "./protocol.js";

const DEFAULT_THROTTLE_MS = 75;
const DEFAULT_KILL_GRACE_MS = 2_000;
const STDERR_CAP_BYTES = 16 * 1024;
const DIAGNOSTIC_CAP_BYTES = 8 * 1024;
const OUTPUT_PREVIEW_BYTES = 4 * 1024;
const ACTIVITY_TITLE_BYTES = 512;
const ASSISTANT_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Resolve a stable, canonical model label from a child assistant event. */
export function resolveSubagentModelLabel(current: string, provider?: string, model?: string): string {
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

export type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;
export type SpawnChild = (
    command: string,
    args: readonly string[],
    options: {
        cwd: string;
        shell: false;
        detached: boolean;
        stdio: ["ignore", "pipe", "pipe"];
    },
) => SpawnedChild;

export interface RunSubagentOptions {
    details: SubagentDetailsV1;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onSnapshot?: (details: SubagentDetailsV1) => void;
    throttleMs?: number;
    killGraceMs?: number;
    now?: () => number;
    spawn?: SpawnChild;
}

export interface SubagentRunResult {
    details: SubagentDetailsV1;
    output: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

interface JsonEvent {
    type: string;
    [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function compactToolTitle(toolName: string, input: unknown): string {
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
    return truncateUtf8(title, ACTIVITY_TITLE_BYTES).content;
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

function snapshot(details: SubagentDetailsV1): SubagentDetailsV1 {
    return structuredClone(details);
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

function spawnDefault(
    command: string,
    args: readonly string[],
    options: { cwd: string; shell: false; detached: boolean; stdio: ["ignore", "pipe", "pipe"] },
): SpawnedChild {
    return nodeSpawn(command, [...args], options);
}

/**
 * Run one child Pi process and always return a structured terminal snapshot.
 * The caller decides whether a failed terminal result should be thrown as a tool error.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
    if (!isSubagentDetailsV1(options.details)) throw new Error("runSubagent requires valid protocol v1 details");

    const now = options.now ?? Date.now;
    const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS);
    const killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    const spawnChild = options.spawn ?? spawnDefault;
    let details = snapshot(options.details);
    let child: SpawnedChild | undefined;
    let stderr = "";
    let diagnostics = "";
    let finalMessage: AssistantMessage | undefined;
    let finalOutput = "";
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;
    let terminationReason: Extract<SubagentTerminalStatus, "cancelled" | "timed_out"> | undefined;
    let settled = false;
    let closed = false;
    let updateTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let lastEmission = Number.NEGATIVE_INFINITY;
    const finalizedMessages = new Set<string>();
    const activeTools = new Map<string, SubagentActiveToolV1>();

    const notifySnapshot = () => {
        if (!options.onSnapshot) return;
        try {
            options.onSnapshot(snapshot(details));
        } catch {
            // Renderer progress must never be able to strand the child process.
        }
    };

    const deliver = () => {
        if (settled || !options.onSnapshot) return;
        lastEmission = now();
        notifySnapshot();
    };

    const emit = (force = false) => {
        if (settled || !options.onSnapshot) return;
        const wait = throttleMs - (now() - lastEmission);
        if (force || wait <= 0) {
            if (updateTimer) clearTimeout(updateTimer);
            updateTimer = undefined;
            deliver();
            return;
        }
        if (!updateTimer) {
            updateTimer = setTimeout(() => {
                updateTimer = undefined;
                deliver();
            }, wait);
        }
    };

    const addActivity = (
        kind: "turn" | "tool_start" | "tool_end" | "assistant" | "diagnostic",
        title: string,
        isError?: boolean,
        timestamp = now(),
    ) => {
        details = appendSubagentActivity(
            details,
            {
                timestamp,
                kind,
                title: truncateUtf8(title, ACTIVITY_TITLE_BYTES).content,
                ...(isError === undefined ? {} : { isError }),
            },
            timestamp,
        );
    };

    const addDiagnostic = (message: string, isError = true) => {
        const bounded = truncateUtf8(message, ACTIVITY_TITLE_BYTES).content;
        diagnostics = appendBoundedUtf8(diagnostics, `${diagnostics ? "\n" : ""}${bounded}`, DIAGNOSTIC_CAP_BYTES);
        addActivity("diagnostic", bounded, isError);
        emit();
    };

    const syncActiveTools = (phase?: "thinking" | "tool" | "exiting") => {
        details = updateSubagentDetails(
            details,
            {
                activeTools: [...activeTools.values()],
                phase: phase ?? (activeTools.size > 0 ? "tool" : "thinking"),
            },
            now(),
        );
    };

    const processEvent = (eventValue: unknown) => {
        if (settled || !isJsonEvent(eventValue)) return;
        const event = eventValue;
        const timestamp = numberOrUndefined(event.timestamp) ?? now();

        if (event.type === "turn_start") {
            const index = numberOrUndefined(event.turnIndex);
            addActivity(
                "turn",
                index === undefined ? "Turn started" : `Turn ${index + 1} started`,
                undefined,
                timestamp,
            );
            details = updateSubagentDetails(details, { phase: activeTools.size > 0 ? "tool" : "thinking" }, timestamp);
            emit();
            return;
        }

        if (event.type === "turn_end") {
            const index = numberOrUndefined(event.turnIndex);
            addActivity(
                "turn",
                index === undefined ? "Turn completed" : `Turn ${index + 1} completed`,
                undefined,
                timestamp,
            );
            details = updateSubagentDetails(details, { phase: activeTools.size > 0 ? "tool" : "thinking" }, timestamp);
            emit();
            return;
        }

        if (event.type === "tool_execution_start") {
            const id = stringOrUndefined(event.toolCallId);
            const name = stringOrUndefined(event.toolName);
            if (!id || !name) {
                addDiagnostic("Child emitted an invalid tool_execution_start event.");
                return;
            }
            const title = compactToolTitle(name, event.args);
            activeTools.set(id, { id, name, title, startedAt: timestamp });
            addActivity("tool_start", title, undefined, timestamp);
            syncActiveTools("tool");
            emit(true);
            return;
        }

        if (event.type === "tool_execution_update") {
            const id = stringOrUndefined(event.toolCallId);
            const active = id ? activeTools.get(id) : undefined;
            if (id && active) {
                activeTools.set(id, { ...active, title: compactToolTitle(active.name, event.args) });
                syncActiveTools("tool");
                emit();
            }
            return;
        }

        if (event.type === "tool_execution_end") {
            const id = stringOrUndefined(event.toolCallId);
            const name = stringOrUndefined(event.toolName) ?? "tool";
            const active = id ? activeTools.get(id) : undefined;
            const title = active?.title ?? compactToolTitle(name, undefined);
            if (id) activeTools.delete(id);
            addActivity("tool_end", title, event.isError === true, timestamp);
            syncActiveTools();
            emit(true);
            return;
        }

        if (event.type === "message_update") {
            if (!isRecord(event.message) || event.message.role !== "assistant") return;
            const preview = assistantText(event.message);
            const model = resolveSubagentModelLabel(
                details.run.model,
                stringOrUndefined(event.message.provider),
                stringOrUndefined(event.message.model),
            );
            details = updateSubagentDetails(
                details,
                {
                    ...(preview ? { outputPreview: truncateUtf8(preview, OUTPUT_PREVIEW_BYTES).content } : {}),
                    model,
                    phase: activeTools.size > 0 ? "tool" : "thinking",
                },
                timestamp,
            );
            emit();
            return;
        }

        if (event.type === "message_end") {
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
                details = updateSubagentDetails(
                    details,
                    { usage: aggregateSubagentUsage(details.run.usage, event.message.usage) },
                    timestamp,
                );
            }
            const model = resolveSubagentModelLabel(
                details.run.model,
                stringOrUndefined(event.message.provider),
                stringOrUndefined(event.message.model),
            );
            const preview = truncateUtf8(finalOutput, OUTPUT_PREVIEW_BYTES).content;
            const stopReason = stringOrUndefined(event.message.stopReason);
            const title = preview
                ? `Assistant: ${shorten(preview, "response")}`
                : stopReason === "toolUse"
                  ? "Assistant requested tools"
                  : "Assistant response completed";
            addActivity("assistant", title, stopReason === "error" || stopReason === "aborted", timestamp);
            details = updateSubagentDetails(
                details,
                {
                    model,
                    ...(preview ? { outputPreview: preview } : {}),
                    phase: activeTools.size > 0 ? "tool" : "thinking",
                },
                timestamp,
            );
            emit();
            return;
        }

        if (event.type === "agent_end" || event.type === "agent_settled") {
            details = updateSubagentDetails(details, { phase: "exiting" }, timestamp);
            emit();
        }
    };

    const parser = new JsonLineParser({
        onValue: processEvent,
        onDiagnostic: (message) => addDiagnostic(message),
    });

    const sendSignal = (signal: NodeJS.Signals) => {
        if (!child || closed) return;
        if (process.platform !== "win32" && child.pid) {
            try {
                process.kill(-child.pid, signal);
                return;
            } catch {
                // Fall back to signaling just the direct child.
            }
        }
        try {
            child.kill(signal);
        } catch {
            // The process may already have exited between the checks.
        }
    };

    const requestTermination = (reason: Extract<SubagentTerminalStatus, "cancelled" | "timed_out">) => {
        if (settled || closed || terminationReason) return;
        terminationReason = reason;
        details = updateSubagentDetails(details, { phase: "exiting" }, now());
        addActivity("diagnostic", reason === "cancelled" ? "Cancellation requested" : "Timeout reached", true);
        emit(true);
        sendSignal("SIGTERM");
        killTimer = setTimeout(() => sendSignal("SIGKILL"), killGraceMs);
    };

    const abortListener = () => requestTermination("cancelled");

    const finalize = (): SubagentRunResult => {
        if (updateTimer) clearTimeout(updateTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        updateTimer = timeoutTimer = killTimer = undefined;
        if (options.signal) options.signal.removeEventListener("abort", abortListener);

        const stopReason = finalMessage?.stopReason;
        const stderrOrDiagnostic = stderr.trim() || diagnostics.trim();
        const outputOrDiagnostic = finalOutput.trim() || stderrOrDiagnostic;
        let status: SubagentTerminalStatus;
        let error: string | undefined;

        if (terminationReason === "cancelled") {
            status = "cancelled";
            error = boundedDiagnostic("Subagent was cancelled.", outputOrDiagnostic);
        } else if (terminationReason === "timed_out") {
            status = "timed_out";
            error = boundedDiagnostic(
                `Subagent timed out after ${options.timeoutMs / 1000} seconds.`,
                outputOrDiagnostic,
            );
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

        addActivity(
            status === "succeeded" ? "assistant" : "diagnostic",
            status === "succeeded" ? "Subagent completed" : error?.split("\n", 1)[0] || "Subagent failed",
            status !== "succeeded",
        );
        const preview = truncateUtf8(finalOutput, OUTPUT_PREVIEW_BYTES).content;
        details = createTerminalSubagentDetails(
            details,
            {
                status,
                ...(error ? { error } : {}),
                ...(preview ? { outputPreview: preview } : {}),
                ...(finalMessage
                    ? {
                          model: resolveSubagentModelLabel(
                              details.run.model,
                              finalMessage.provider,
                              finalMessage.model,
                          ),
                      }
                    : {}),
            },
            now(),
        );
        settled = true;
        notifySnapshot();

        if (child) {
            child.stdout.removeAllListeners();
            child.stderr.removeAllListeners();
            child.removeAllListeners();
        }
        return { details, output: finalOutput, stderr, exitCode, signal: exitSignal };
    };

    if (options.signal?.aborted) {
        terminationReason = "cancelled";
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
    details = updateSubagentDetails(
        details,
        {
            status: "running",
            phase: "thinking",
            startedAt: details.run.startedAt ?? startedAt,
            activeTools: [],
        },
        startedAt,
    );
    emit(true);

    return new Promise<SubagentRunResult>((resolve) => {
        runningChild.stdout.on("data", (chunk: Buffer | string) => {
            try {
                parser.write(chunk);
            } catch (error) {
                addDiagnostic(
                    `Unable to process child output: ${error instanceof Error ? error.message : String(error)}`,
                );
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
            if (terminationReason && killTimer) sendSignal("SIGKILL");
            closed = true;
            exitCode = code;
            exitSignal = signal;
            parser.end();
            resolve(finalize());
        });

        if (options.signal) options.signal.addEventListener("abort", abortListener, { once: true });
        if (options.timeoutMs > 0) {
            timeoutTimer = setTimeout(() => requestTermination("timed_out"), options.timeoutMs);
        }
        if (options.signal?.aborted) abortListener();
    });
}
