import type { SubagentStatus } from "#modules/subagents/interfaces/ui.js";
import { theme } from "./theme.js";

export function subagentColor(status: SubagentStatus): string {
    switch (status) {
        case "completed":
            return theme.success;
        case "failed":
        case "timed_out":
            return theme.error;
        case "cancelled":
        case "queued":
            return theme.muted;
        case "running":
            return theme.warning;
    }
}

export function subagentStatusIcon(status: SubagentStatus): string {
    switch (status) {
        case "completed":
            return "✓";
        case "failed":
            return "×";
        case "cancelled":
            return "⊘";
        case "timed_out":
            return "⧖";
        case "queued":
            return "○";
        case "running":
            return "◌";
    }
}

export function subagentStatusLabel(status: SubagentStatus): string {
    return status === "timed_out" ? "timed out" : status;
}

function formatElapsed(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

interface SubagentTiming {
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
}

export function subagentElapsed(view: SubagentTiming, now = Date.now()): string {
    const start = view.startedAt ?? view.createdAt;
    const end = view.endedAt ?? now;
    return formatElapsed(Math.max(0, end - start));
}

export function compactSubagentTask(task: string): string {
    const oneLine = task.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}
