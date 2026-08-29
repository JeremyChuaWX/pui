export interface InstanceScopedJobs<T> {
    instanceId?: string;
    /** A validated reset permits the producer's replacement instance to establish authority. */
    acceptingInstance?: true;
    jobs: ReadonlyMap<string, T>;
}

export type InstanceScopedJobEvent<T> =
    | { type: "ready"; instanceId: string }
    | { type: "reset"; instanceId: string }
    | { type: "upsert"; instanceId: string; job: T }
    | { type: "remove"; instanceId: string; job: T };

/** Copy-on-write reducer for Job sets owned by one routed producer instance. */
export function reduceInstanceScopedJobs<T>(
    state: InstanceScopedJobs<T>,
    event: InstanceScopedJobEvent<T>,
    options: { routeMatches: boolean; maxJobs: number; id: (job: T) => string },
): InstanceScopedJobs<T> {
    if (!options.routeMatches) return state;
    if (event.type === "ready") {
        if (state.instanceId !== undefined && state.instanceId !== event.instanceId && !state.acceptingInstance)
            return state;
        return state.instanceId === event.instanceId && !state.acceptingInstance
            ? state
            : { instanceId: event.instanceId, jobs: new Map() };
    }
    if (event.type === "reset") {
        if (event.instanceId !== state.instanceId) return state;
        return { instanceId: state.instanceId, acceptingInstance: true, jobs: new Map() };
    }
    if (state.acceptingInstance || event.instanceId !== state.instanceId) return state;
    const id = options.id(event.job);
    if (event.type === "upsert" && !state.jobs.has(id) && state.jobs.size >= options.maxJobs) return state;
    const jobs = new Map(state.jobs);
    if (event.type === "upsert") jobs.set(id, event.job);
    else jobs.delete(id);
    return { instanceId: state.instanceId, jobs };
}
