import type { ScrollBoxRenderable } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import type { WorkflowRunSummaryV1 } from "../../extensions/workflow/protocol.js";
import { formatCount, workflowStatusPresentation, workflowStatusTone } from "../format.js";
import { theme } from "../theme.js";
import { dismissKeyHint } from "./keys.js";

const WORKFLOW_PAGE_AGENT_LIMIT = 100;

export function WorkflowPage(props: { run: WorkflowRunSummaryV1; setRef: (value: ScrollBoxRenderable) => void }) {
    const runState = () => workflowStatusPresentation(props.run.status);
    const agentsById = createMemo(() => new Map(props.run.agents.map((agent) => [agent.id, agent])));
    const runColor = () => theme[workflowStatusTone(props.run.status)];
    return (
        <scrollbox
            ref={props.setRef}
            flexGrow={1}
            minHeight={0}
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{ visible: false }}
            contentOptions={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}
        >
            <box border={["bottom"]} borderColor={theme.border} paddingBottom={1} marginBottom={1}>
                <text fg={runColor()}>
                    <strong>
                        {runState().icon} Workflow · {props.run.name}
                    </strong>
                </text>
                <text fg={theme.muted}>
                    {runState().label} · {props.run.phases.length} phases · {props.run.agents.length} agents ·{" "}
                    {formatCount(props.run.usage.totalTokens)} tokens · {dismissKeyHint} to return
                </text>
                <Show when={props.run.warning}>
                    <text fg={theme.warning}>{props.run.warning}</text>
                </Show>
                <Show when={props.run.error}>
                    <text fg={theme.error}>{props.run.error}</text>
                </Show>
            </box>
            <For each={props.run.phases}>
                {(phase, index) => {
                    const phaseStatus = () => workflowStatusPresentation(phase.status);
                    return (
                        <box
                            marginBottom={1}
                            border={["left"]}
                            borderColor={phase.status === "running" ? theme.warning : theme.border}
                            paddingLeft={2}
                        >
                            <text fg={phase.status === "running" ? theme.warning : theme.text}>
                                <strong>
                                    {phaseStatus().icon} Phase {index() + 1} · {phase.name}
                                </strong>
                                <span> · {phaseStatus().label}</span>
                            </text>
                            <For each={phase.agentIds.slice(0, WORKFLOW_PAGE_AGENT_LIMIT)}>
                                {(agentId) => {
                                    const agent = createMemo(() => agentsById().get(agentId));
                                    const state = createMemo(() => {
                                        const value = agent();
                                        return value ? workflowStatusPresentation(value.status) : undefined;
                                    });
                                    return (
                                        <text
                                            fg={
                                                agent()?.status === "failed" || agent()?.status === "timed_out"
                                                    ? theme.error
                                                    : theme.subtle
                                            }
                                            wrapMode="none"
                                        >
                                            {state()?.icon ?? "?"} {agent()?.label ?? agentId} ·{" "}
                                            {state()?.label ?? "Unavailable"}
                                            {agent()?.role ? ` · ${agent()?.role}` : ""}
                                        </text>
                                    );
                                }}
                            </For>
                            <Show when={phase.agentIds.length > WORKFLOW_PAGE_AGENT_LIMIT}>
                                <text fg={theme.muted}>
                                    … {phase.agentIds.length - WORKFLOW_PAGE_AGENT_LIMIT} more agents
                                </text>
                            </Show>
                            <Show when={phase.agentIds.length === 0}>
                                <text fg={theme.muted}>No agents in this phase</text>
                            </Show>
                        </box>
                    );
                }}
            </For>
        </scrollbox>
    );
}
