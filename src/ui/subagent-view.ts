import { formatCount } from "../format.js";
import type { SubagentStatus, SubagentUsage, SubagentViewModel } from "../subagent.js";
import { theme } from "../theme.js";

export function subagentColor(status: SubagentStatus): string {
    switch (status) {
        case "succeeded":
            return theme.success;
        case "failed":
        case "timed_out":
            return theme.error;
        case "cancelled":
        case "queued":
            return theme.muted;
        case "starting":
            return theme.info;
        case "running":
            return theme.warning;
    }
}

export function subagentStatusIcon(status: SubagentStatus): string {
    switch (status) {
        case "succeeded":
            return "✓";
        case "failed":
            return "×";
        case "cancelled":
            return "⊘";
        case "timed_out":
            return "⧖";
        case "queued":
            return "○";
        case "starting":
        case "running":
            return "◌";
    }
}

export function subagentStatusLabel(status: SubagentStatus): string {
    return status === "timed_out" ? "timed out" : status.replace("_", " ");
}

function formatElapsed(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

export function subagentElapsed(view: SubagentViewModel, now = Date.now()): string {
    const start = view.startedAt ?? view.updatedAt;
    const end = view.endedAt ?? now;
    return formatElapsed(Math.max(0, end - start));
}

export function compactSubagentUsage(usage: SubagentUsage): string {
    const parts: string[] = [];
    if (usage.turns > 0) parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
    if (usage.totalTokens > 0) parts.push(`${formatCount(usage.totalTokens)} tokens`);
    return parts.join(" · ");
}

export function subagentSummary(view: SubagentViewModel, now = Date.now()): string {
    const parts = [view.agent];
    if (view.model) parts.push(view.model);
    if (view.status !== "succeeded") parts.push(subagentStatusLabel(view.status));
    parts.push(subagentElapsed(view, now));
    const usage = compactSubagentUsage(view.usage);
    if (usage) parts.push(usage);
    return parts.join(" · ");
}
