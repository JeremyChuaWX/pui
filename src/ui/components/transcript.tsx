import { createMemo, Match, Show, Switch } from "solid-js";
import type { DisplayItem } from "../state/types.js";
import { extensionConfirmKeyHint } from "./keys.js";
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
    const customItem = itemOfKind("custom");
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
