import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { WorkflowRunSummaryV1 } from "../../extensions/workflow/protocol.js";
import { formatCount, formatWorkflowSummary, workflowStatusTone } from "../format.js";
import { isTerminalSubagentStatus, type SubagentViewModel } from "../subagent.js";
import { syntaxStyle, theme } from "../theme.js";
import type { DisplayItem, ToolDisplayItem } from "../types.js";
import { extensionConfirmKeyHint } from "./keys.js";
import {
    subagentColor,
    subagentElapsed,
    subagentStatusIcon,
    subagentStatusLabel,
    subagentSummary,
} from "./subagent-view.js";

export function Welcome(props: { cwd: string }) {
    return (
        <box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center">
            <box alignItems="center" gap={1}>
                <text fg={theme.primary}>
                    <strong>π</strong>
                </text>
                <text fg={theme.text}>
                    <strong>What are we building?</strong>
                </text>
                <text fg={theme.muted}>{props.cwd}</text>
                <text fg={theme.muted}>Type a request, or press Ctrl+K for commands.</text>
            </box>
        </box>
    );
}

export function MessageItem(props: {
    item: () => DisplayItem;
    toolsExpanded: boolean;
    thinkingExpanded: boolean;
    now: number;
}) {
    const userItem = createMemo(() => {
        const item = props.item();
        return item.kind === "user" ? item : undefined;
    });
    const assistantItem = createMemo(() => {
        const item = props.item();
        return item.kind === "assistant" ? item : undefined;
    });
    const thinkingItem = createMemo(() => {
        const item = props.item();
        return item.kind === "thinking" ? item : undefined;
    });
    const toolItem = createMemo(() => {
        const item = props.item();
        return item.kind === "tool" ? item : undefined;
    });
    const bashItem = createMemo(() => {
        const item = props.item();
        return item.kind === "bash" ? item : undefined;
    });
    const summaryItem = createMemo(() => {
        const item = props.item();
        return item.kind === "summary" ? item : undefined;
    });
    const customItem = createMemo(() => {
        const item = props.item();
        return item.kind === "custom" ? item : undefined;
    });
    const isSubagentResult = createMemo(() => customItem()?.label === "subagent-result");
    const toolColor = () => (toolItem()?.isError ? theme.error : toolItem()?.running ? theme.warning : theme.success);
    const bashColor = () =>
        bashItem()?.running
            ? theme.warning
            : bashItem()?.cancelled || (bashItem()?.exitCode ?? 0) !== 0
              ? theme.error
              : theme.success;

    return (
        <Switch>
            <Match when={userItem()}>
                <box marginTop={1} border={["left"]} borderColor={theme.primary} backgroundColor={theme.userBackground}>
                    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                        <text fg={theme.text}>{userItem()?.text}</text>
                    </box>
                </box>
            </Match>
            <Match when={assistantItem()}>
                <box marginTop={1} paddingLeft={1} paddingRight={1}>
                    <markdown
                        syntaxStyle={syntaxStyle}
                        streaming={true}
                        internalBlockMode="top-level"
                        content={assistantItem()?.text}
                        conceal
                        fg={theme.text}
                        bg={theme.background}
                    />
                </box>
            </Match>
            <Match when={thinkingItem()}>
                <box
                    marginTop={1}
                    border={["left"]}
                    borderColor={theme.secondary}
                    paddingLeft={2}
                    paddingTop={1}
                    paddingBottom={1}
                >
                    <text fg={theme.secondary}>◇ Reasoning</text>
                    <Show
                        when={props.thinkingExpanded}
                        fallback={<text fg={theme.muted}>hidden · Ctrl+T to expand</text>}
                    >
                        <text fg={theme.muted}>{thinkingItem()?.text}</text>
                    </Show>
                </box>
            </Match>
            <Match when={toolItem()?.workflow}>
                {(workflow) => <WorkflowTool run={workflow()} expanded={props.toolsExpanded} />}
            </Match>
            <Match when={toolItem()}>
                <Show
                    when={toolItem()?.subagent}
                    fallback={
                        <box
                            marginTop={1}
                            border={["left"]}
                            borderColor={toolColor()}
                            backgroundColor={theme.toolBackground}
                        >
                            <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                                <box flexDirection="row">
                                    <text fg={toolColor()}>
                                        {toolItem()?.running ? "◌" : toolItem()?.isError ? "×" : "✓"}{" "}
                                    </text>
                                    <text fg={theme.text}>{toolItem()?.title}</text>
                                </box>
                                <Show when={props.toolsExpanded && toolItem()?.args}>
                                    <text fg={theme.muted}>{toolItem()?.args}</text>
                                </Show>
                                <Show when={props.toolsExpanded && toolItem()?.result}>
                                    <text fg={toolItem()?.isError ? theme.error : theme.subtle}>
                                        {toolItem()?.result}
                                    </text>
                                </Show>
                                <Show when={!props.toolsExpanded && toolItem()?.result}>
                                    <text fg={theme.muted}>Ctrl+O to show output</text>
                                </Show>
                            </box>
                        </box>
                    }
                >
                    {(subagent) => (
                        <SubagentTool
                            item={toolItem()}
                            subagent={subagent()}
                            expanded={props.toolsExpanded}
                            now={props.now}
                        />
                    )}
                </Show>
            </Match>
            <Match when={bashItem()}>
                <box marginTop={1} border={["left"]} borderColor={bashColor()} backgroundColor={theme.toolBackground}>
                    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                        <text fg={bashColor()}>
                            {bashItem()?.running ? "◌" : "›"} shell{bashItem()?.excluded ? " · excluded" : ""}
                        </text>
                        <text fg={theme.text}>$ {bashItem()?.command}</text>
                        <Show when={bashItem()?.output}>
                            <text fg={theme.muted}>{bashItem()?.output}</text>
                        </Show>
                    </box>
                </box>
            </Match>
            <Match when={summaryItem()}>
                <box marginTop={1} border={["left"]} borderColor={theme.secondary} paddingLeft={2} paddingTop={1}>
                    <text fg={theme.secondary}>{summaryItem()?.label}</text>
                    <markdown
                        syntaxStyle={syntaxStyle}
                        internalBlockMode="top-level"
                        content={summaryItem()?.text}
                        conceal
                        fg={theme.muted}
                        bg={theme.background}
                    />
                </box>
            </Match>
            <Match when={customItem()}>
                <box
                    marginTop={1}
                    border={["left"]}
                    borderColor={
                        customItem()?.label === "error" ? theme.error : isSubagentResult() ? theme.success : theme.info
                    }
                    paddingLeft={2}
                    paddingTop={isSubagentResult() ? 1 : 0}
                    paddingBottom={isSubagentResult() ? 1 : 0}
                >
                    <text fg={customItem()?.label === "error" ? theme.error : theme.info}>
                        {isSubagentResult() ? "✓ Background subagent result" : customItem()?.label || "message"}
                    </text>
                    <Show when={isSubagentResult()} fallback={<text fg={theme.text}>{customItem()?.text}</text>}>
                        <markdown
                            syntaxStyle={syntaxStyle}
                            content={customItem()?.text}
                            conceal
                            fg={theme.text}
                            bg={theme.background}
                        />
                    </Show>
                </box>
            </Match>
        </Switch>
    );
}

function WorkflowTool(props: { run: WorkflowRunSummaryV1; expanded: boolean }) {
    const color = () => theme[workflowStatusTone(props.run.status)];
    return (
        <box marginTop={1} border={["left"]} borderColor={color()} backgroundColor={theme.toolBackground}>
            <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                <text fg={color()} wrapMode="none">
                    {formatWorkflowSummary(props.run)}
                </text>
                <Show
                    when={props.expanded}
                    fallback={<text fg={theme.muted}>Ctrl+O to show workflow details · /workflows to control</text>}
                >
                    <text fg={theme.muted}>
                        {props.run.phases.length} phases · {formatCount(props.run.usage.totalTokens)} tokens · $
                        {props.run.usage.cost.toFixed(4)}
                    </text>
                    <For each={props.run.phases.slice(0, 12)}>
                        {(phase) => (
                            <text fg={theme.subtle} wrapMode="none">
                                · {phase.name} · {phase.status} · {phase.agentIds.length} agents
                            </text>
                        )}
                    </For>
                    <Show when={props.run.phases.length > 12}>
                        <text fg={theme.muted}>… {props.run.phases.length - 12} more phases</text>
                    </Show>
                    <Show when={props.run.warning}>
                        <text fg={theme.warning}>{props.run.warning}</text>
                    </Show>
                    <Show when={props.run.error}>
                        <text fg={theme.error}>{props.run.error}</text>
                    </Show>
                    <text fg={theme.muted}>use /workflows for bounded agent/activity inspection</text>
                </Show>
            </box>
        </box>
    );
}

function SubagentTool(props: { item?: ToolDisplayItem; subagent: SubagentViewModel; expanded: boolean; now: number }) {
    const color = () => subagentColor(props.subagent.status);
    const finalOutput = () =>
        isTerminalSubagentStatus(props.subagent.status) && !props.item?.isError ? props.item?.result : undefined;
    const livePreview = () =>
        !isTerminalSubagentStatus(props.subagent.status) ? props.subagent.outputPreview : undefined;
    const usageDetails = () => {
        const usage = props.subagent.usage;
        return [
            `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`,
            `${formatCount(usage.input)} in`,
            `${formatCount(usage.output)} out`,
            `${formatCount(usage.cacheRead)} cache read`,
            `${formatCount(usage.cacheWrite)} cache write`,
            `${formatCount(usage.totalTokens)} total`,
        ].join(" · ");
    };

    return (
        <box marginTop={1} border={["left"]} borderColor={color()} backgroundColor={theme.toolBackground}>
            <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                <box flexDirection="row" minWidth={0}>
                    <text fg={color()}>{subagentStatusIcon(props.subagent.status)} </text>
                    <text fg={theme.text} wrapMode="none">
                        {subagentSummary(props.subagent, props.now)}
                    </text>
                </box>
                <Show when={!props.expanded && props.subagent.error}>
                    <text fg={theme.error} wrapMode="none">
                        {props.subagent.error}
                    </text>
                </Show>
                <Show when={props.expanded}>
                    <box marginTop={1} gap={1}>
                        <Show when={props.subagent.prompt}>
                            {(prompt) => (
                                <box>
                                    <text fg={theme.secondary}>Delegated prompt</text>
                                    <text fg={theme.text}>{prompt()}</text>
                                </box>
                            )}
                        </Show>

                        <box>
                            <text fg={theme.secondary}>Run</text>
                            <text fg={theme.muted}>{props.subagent.cwd || "(working directory unavailable)"}</text>
                            <text fg={theme.muted}>
                                {subagentStatusLabel(props.subagent.status)} · {props.subagent.model} ·{" "}
                                {subagentElapsed(props.subagent, props.now)}
                            </text>
                        </box>

                        <Show when={props.subagent.activeTools.length > 0}>
                            <box>
                                <text fg={theme.secondary}>Active child tools</text>
                                <For each={props.subagent.activeTools}>
                                    {(tool) => <text fg={theme.warning}>◌ {tool.title}</text>}
                                </For>
                            </box>
                        </Show>

                        <Show when={props.subagent.recentActivity.length > 0}>
                            <box>
                                <text fg={theme.secondary}>Recent activity</text>
                                <For each={props.subagent.recentActivity}>
                                    {(activity) => (
                                        <text fg={activity.isError ? theme.error : theme.muted}>
                                            {activity.kind === "tool_start" ? "›" : "·"} {activity.title}
                                        </text>
                                    )}
                                </For>
                            </box>
                        </Show>

                        <box>
                            <text fg={theme.secondary}>Usage</text>
                            <text fg={theme.muted}>{usageDetails()}</text>
                        </box>

                        <Show when={props.subagent.error}>
                            {(error) => (
                                <box>
                                    <text fg={theme.error}>Diagnostic</text>
                                    <text fg={theme.error}>{error()}</text>
                                </box>
                            )}
                        </Show>

                        <Show when={livePreview()}>
                            {(preview) => (
                                <box>
                                    <text fg={theme.secondary}>Live output</text>
                                    <markdown
                                        syntaxStyle={syntaxStyle}
                                        internalBlockMode="top-level"
                                        content={preview()}
                                        conceal
                                        fg={theme.subtle}
                                        bg={theme.toolBackground}
                                    />
                                </box>
                            )}
                        </Show>

                        <Show when={finalOutput()}>
                            {(output) => (
                                <box>
                                    <text fg={theme.secondary}>Output</text>
                                    <markdown
                                        syntaxStyle={syntaxStyle}
                                        internalBlockMode="top-level"
                                        content={output()}
                                        conceal
                                        fg={theme.text}
                                        bg={theme.toolBackground}
                                    />
                                </box>
                            )}
                        </Show>

                        <Show when={props.subagent.fullOutputPath}>
                            {(outputPath) => <text fg={theme.muted}>Full output: {outputPath()}</text>}
                        </Show>
                    </box>
                </Show>
                <Show when={!props.expanded && (finalOutput() || livePreview())}>
                    <text fg={theme.muted}>Ctrl+O to show subagent details</text>
                </Show>
            </box>
        </box>
    );
}

export function QueuedMessage(props: { message: string; label: string; color: string }) {
    return (
        <box marginTop={1} border={["left"]} borderColor={props.color} paddingLeft={2}>
            <text fg={props.color}>queued · {props.label}</text>
            <text fg={theme.muted}>{props.message}</text>
        </box>
    );
}

export function ExtensionConfirmation(props: { title: string; message: string }) {
    return (
        <box border={["left"]} borderColor={theme.warning} paddingLeft={2} paddingRight={1} gap={1}>
            <text fg={theme.warning}>
                <strong>{props.title}</strong>
            </text>
            <text fg={theme.text}>{props.message}</text>
            <text fg={theme.warning}>{extensionConfirmKeyHint}</text>
        </box>
    );
}
