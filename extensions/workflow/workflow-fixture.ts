interface WorkflowFixtureAgent {
    id: string;
    label: string;
    role: string;
    status: string;
    updatedAt: number;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: number;
        turns: number;
    };
    recentActivity: unknown[];
    output?: string;
    worktree?: unknown;
}

export function workflowRun(agentCount = 1) {
    const agents: WorkflowFixtureAgent[] = Array.from({ length: agentCount }, (_, index) => ({
        id: `agent-${index}`,
        label: `Agent ${index}`,
        role: "worker",
        status: "running",
        updatedAt: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
        recentActivity: [],
    }));
    return {
        schema: "pi.workflow",
        version: 1,
        id: "run-1",
        name: "Review",
        sessionId: "session-1",
        cwd: "/canonical/repo",
        status: "running",
        phases: [{ id: "phase-1", name: "Review", status: "running", updatedAt: 2, agentIds: agents.map((a) => a.id) }],
        agents,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
        limits: { maxConcurrency: 4, maxAgents: 1_000, timeoutMs: 60_000, maxTokens: 0, maxCost: 0 },
        recentActivity: [],
        updatedAt: 2,
    };
}
