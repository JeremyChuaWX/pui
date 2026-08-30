import { createMemo, Match, Show, Switch } from "solid-js";
import type { DisplayItem } from "../state/types.js";
import { extensionConfirmKeyHint } from "./keys.js";
import { compactSubagentTask, subagentColor, subagentStatusIcon, subagentStatusLabel } from "./subagent-view.js";
import { syntaxStyle, theme } from "./theme.js";

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
    const itemOfKind = <K extends DisplayItem["kind"]>(kind: K) =>
        createMemo(() => {
            const item = props.item();
            return item.kind === kind ? (item as Extract<DisplayItem, { kind: K }>) : undefined;
        });
    const userItem = itemOfKind("user");
    const assistantItem = itemOfKind("assistant");
    const thinkingItem = itemOfKind("thinking");
    const toolItem = itemOfKind("tool");
    const bashItem = itemOfKind("bash");
    const summaryItem = itemOfKind("summary");
    const subagentResultItem = itemOfKind("subagentResult");
    const customItem = itemOfKind("custom");
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
            <Match when={toolItem()}>
                <box marginTop={1} border={["left"]} borderColor={toolColor()} backgroundColor={theme.toolBackground}>
                    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                        <box flexDirection="row">
                            <text fg={toolColor()}>{toolItem()?.running ? "◌" : toolItem()?.isError ? "×" : "✓"} </text>
                            <text fg={theme.text}>{toolItem()?.title}</text>
                        </box>
                        <Show when={props.toolsExpanded && toolItem()?.args}>
                            <text fg={theme.muted}>{toolItem()?.args}</text>
                        </Show>
                        <Show when={props.toolsExpanded && toolItem()?.result}>
                            <text fg={toolItem()?.isError ? theme.error : theme.subtle}>{toolItem()?.result}</text>
                        </Show>
                        <Show when={!props.toolsExpanded && toolItem()?.result}>
                            <text fg={theme.muted}>Ctrl+O to show output</text>
                        </Show>
                    </box>
                </box>
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
            <Match when={subagentResultItem()}>
                {(() => {
                    const result = subagentResultItem()?.result;
                    if (!result) return null;
                    const tokens =
                        result.totalTokens === undefined ? "" : ` · ${Math.round(result.totalTokens / 1_000)}k tokens`;
                    return (
                        <box
                            marginTop={1}
                            border={["left"]}
                            borderColor={subagentColor(result.status)}
                            paddingLeft={2}
                            paddingTop={1}
                            paddingBottom={1}
                        >
                            <text fg={subagentColor(result.status)}>
                                {subagentStatusIcon(result.status)} [{result.id}] {subagentStatusLabel(result.status)} ·{" "}
                                {Math.round(result.runtimeMs / 1_000)}s{tokens}
                                {result.partial ? " · partial output" : ""}
                            </text>
                            <Show
                                when={props.toolsExpanded}
                                fallback={
                                    <>
                                        <text fg={theme.muted}>{compactSubagentTask(result.task)}</text>
                                        <text fg={theme.muted}>Ctrl+O to show output</text>
                                    </>
                                }
                            >
                                <text fg={theme.muted}>Task: {result.task}</text>
                                <text fg={theme.muted}>Full output: {result.location}</text>
                                <Show when={result.preview}>
                                    <markdown
                                        syntaxStyle={syntaxStyle}
                                        content={result.preview}
                                        conceal
                                        fg={theme.text}
                                        bg={theme.background}
                                    />
                                </Show>
                            </Show>
                        </box>
                    );
                })()}
            </Match>
            <Match when={customItem()}>
                <box
                    marginTop={1}
                    border={["left"]}
                    borderColor={customItem()?.label === "error" ? theme.error : theme.info}
                    paddingLeft={2}
                >
                    <text fg={customItem()?.label === "error" ? theme.error : theme.info}>
                        {customItem()?.label || "message"}
                    </text>
                    <text fg={theme.text}>{customItem()?.text}</text>
                </box>
            </Match>
        </Switch>
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
