import { createMemo, For, Show } from "solid-js";
import { formatCount, formatWorkflowSummary, workflowStatusTone } from "../format.js";
import { isTerminalSubagentStatus, type SubagentViewModel } from "../subagent.js";
import { theme } from "../theme.js";
import type { DisplayItem, PuiSnapshot, ToastMessage, ToolDisplayItem } from "../types.js";
import {
    compactSubagentUsage,
    subagentColor,
    subagentElapsed,
    subagentStatusIcon,
    subagentStatusLabel,
} from "./subagent-view.js";

export interface SubagentDisplayItem extends ToolDisplayItem {
    subagent: SubagentViewModel;
}

export function activeSubagentItems(display: readonly DisplayItem[]): SubagentDisplayItem[] {
    return display.filter((item): item is SubagentDisplayItem => {
        if (item.kind !== "tool" || !item.subagent) return false;
        return !isTerminalSubagentStatus(item.subagent.status);
    });
}

function progressBar(percent: number | null | undefined, width = 14): string {
    const value = Math.max(0, Math.min(100, percent ?? 0));
    const filled = Math.round((value / 100) * width);
    return `${"━".repeat(filled)}${"─".repeat(width - filled)}`;
}

export function Sidebar(props: { snapshot: PuiSnapshot; now: number }) {
    const subagents = () => activeSubagentItems(props.snapshot.display);
    const subagentIds = () =>
        new Set(
            props.snapshot.display
                .filter((item): item is ToolDisplayItem => item.kind === "tool" && Boolean(item.subagent))
                .map((item) => item.toolCallId),
        );
    const backgroundSubagents = () =>
        props.snapshot.backgroundSubagents.filter((job) => !isTerminalSubagentStatus(job.status));
    const genericTools = () => props.snapshot.activeTools.filter((tool) => !subagentIds().has(tool.id));
    const activeWorkflows = createMemo(() =>
        props.snapshot.workflows.filter((run) => ["queued", "running", "paused"].includes(run.status)),
    );

    return (
        <box
            width={34}
            flexShrink={0}
            backgroundColor={theme.panel}
            border={["left"]}
            borderColor={theme.borderSubtle}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            gap={1}
        >
            <text fg={theme.text}>
                <strong>Session</strong>
            </text>
            <text fg={theme.muted} wrapMode="none">
                {props.snapshot.sessionName || props.snapshot.sessionId.slice(0, 12)}
            </text>
            <text fg={theme.muted} wrapMode="none">
                {props.snapshot.compactCwd}
            </text>

            <box marginTop={1}>
                <text fg={theme.text}>
                    <strong>Context</strong>
                </text>
                <text
                    fg={
                        props.snapshot.contextPercent && props.snapshot.contextPercent > 80
                            ? theme.warning
                            : theme.primary
                    }
                >
                    {progressBar(props.snapshot.contextPercent)} {Math.round(props.snapshot.contextPercent ?? 0)}%
                </text>
                <text fg={theme.muted}>
                    {formatCount(props.snapshot.contextTokens)} / {formatCount(props.snapshot.contextWindow)} tokens
                </text>
            </box>

            <box marginTop={1}>
                <text fg={theme.text}>
                    <strong>Model</strong>
                </text>
                <text fg={theme.primary} wrapMode="none">
                    {props.snapshot.modelId}
                </text>
                <text fg={theme.muted} wrapMode="none">
                    {props.snapshot.modelProvider || "unconfigured"} · {props.snapshot.thinkingLevel}
                </text>
            </box>

            <Show when={subagents().length > 0 || backgroundSubagents().length > 0}>
                <box marginTop={1}>
                    <text fg={theme.text}>
                        <strong>Subagents</strong>
                    </text>
                    <For each={subagents()}>
                        {(item) => (
                            <text fg={subagentColor(item.subagent.status)} wrapMode="none">
                                {subagentStatusIcon(item.subagent.status)} {item.subagent.agent} · {item.subagent.model}{" "}
                                · {subagentStatusLabel(item.subagent.status)} ·{" "}
                                {subagentElapsed(item.subagent, props.now)}
                            </text>
                        )}
                    </For>
                    <For each={backgroundSubagents()}>
                        {(job) => (
                            <box marginBottom={1}>
                                <text fg={subagentColor(job.status)} wrapMode="none">
                                    {subagentStatusIcon(job.status)} {job.title}
                                </text>
                                <text fg={theme.muted} wrapMode="none">
                                    {job.model} · {subagentStatusLabel(job.status)} · {subagentElapsed(job, props.now)}
                                </text>
                                <Show when={compactSubagentUsage(job.usage)}>
                                    {(usage) => (
                                        <text fg={theme.muted} wrapMode="none">
                                            {usage()}
                                        </text>
                                    )}
                                </Show>
                            </box>
                        )}
                    </For>
                </box>
            </Show>

            <Show when={activeWorkflows().length > 0}>
                <box marginTop={1}>
                    <text fg={theme.text}>
                        <strong>Workflows</strong>
                    </text>
                    <For each={activeWorkflows().slice(0, 6)}>
                        {(run) => (
                            <text
                                fg={workflowStatusTone(run.status) === "warning" ? theme.warning : theme.muted}
                                wrapMode="none"
                            >
                                {formatWorkflowSummary(run)}
                            </text>
                        )}
                    </For>
                    <Show when={activeWorkflows().length > 6}>
                        <text fg={theme.muted}>… more · /workflows</text>
                    </Show>
                </box>
            </Show>

            <Show when={genericTools().length > 0}>
                <box marginTop={1}>
                    <text fg={theme.text}>
                        <strong>Running</strong>
                    </text>
                    <For each={genericTools()}>
                        {(tool) => (
                            <text fg={theme.warning} wrapMode="none">
                                ◌ {tool.title}
                            </text>
                        )}
                    </For>
                </box>
            </Show>

            <box flexGrow={1} />
            <text fg={theme.muted}>Ctrl+K commands</text>
        </box>
    );
}

export function ToastStack(props: { toasts: ToastMessage[]; width: number }) {
    return (
        <Show when={props.toasts.length > 0}>
            <box
                position="absolute"
                top={1}
                right={2}
                width={Math.min(54, Math.max(20, props.width - 6))}
                gap={1}
                zIndex={100}
            >
                <For each={props.toasts}>
                    {(toast) => {
                        const color =
                            toast.type === "error"
                                ? theme.error
                                : toast.type === "warning"
                                  ? theme.warning
                                  : toast.type === "success"
                                    ? theme.success
                                    : theme.primary;
                        return (
                            <box
                                border={["left"]}
                                borderColor={color}
                                backgroundColor={theme.element}
                                paddingLeft={2}
                                paddingRight={1}
                                paddingTop={1}
                                paddingBottom={1}
                            >
                                <text fg={color}>{toast.type}</text>
                                <text fg={theme.text}>{toast.message}</text>
                            </box>
                        );
                    }}
                </For>
            </box>
        </Show>
    );
}
