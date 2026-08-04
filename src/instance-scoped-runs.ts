export interface InstanceScopedRuns<T> {
    instanceId?: string;
    /** A validated reset permits the producer's replacement instance to establish authority. */
    acceptingInstance?: true;
    runs: ReadonlyMap<string, T>;
}

export type InstanceScopedRunEvent<T> =
    | { type: "ready"; instanceId: string }
    | { type: "reset"; instanceId: string }
    | { type: "upsert"; instanceId: string; run: T }
    | { type: "remove"; instanceId: string; run: T };

/** Copy-on-write reducer for run sets owned by one routed producer instance. */
export function reduceInstanceScopedRuns<T>(
    state: InstanceScopedRuns<T>,
    event: InstanceScopedRunEvent<T>,
    options: { routeMatches: boolean; maxRuns: number; id: (run: T) => string },
): InstanceScopedRuns<T> {
    if (!options.routeMatches) return state;
    if (event.type === "ready") {
        if (state.instanceId !== undefined && state.instanceId !== event.instanceId && !state.acceptingInstance)
            return state;
        return state.instanceId === event.instanceId && !state.acceptingInstance
            ? state
            : { instanceId: event.instanceId, runs: new Map() };
    }
    if (event.type === "reset") {
        if (event.instanceId !== state.instanceId) return state;
        return { instanceId: state.instanceId, acceptingInstance: true, runs: new Map() };
    }
    if (state.acceptingInstance || event.instanceId !== state.instanceId) return state;
    const id = options.id(event.run);
    if (event.type === "upsert" && !state.runs.has(id) && state.runs.size >= options.maxRuns) return state;
    const runs = new Map(state.runs);
    if (event.type === "upsert") runs.set(id, event.run);
    else runs.delete(id);
    return { instanceId: state.instanceId, runs };
}
