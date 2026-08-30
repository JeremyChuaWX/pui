import { describe, expect, test } from "bun:test";
import { type InstanceScopedJobs, reduceInstanceScopedJobs } from "#modules/subagents/instance-scoped-jobs.ts";

interface Job {
    id: string;
    status: string;
}
const options = { routeMatches: true, maxJobs: 2, id: (job: Job) => job.id };
const upsert = (instanceId: string, id: string, status = "running") =>
    ({ type: "upsert", instanceId, job: { id, status } }) as const;

describe("reduceInstanceScopedJobs", () => {
    test("the first ready establishes authority and later instances are ignored until a reset", () => {
        let state: InstanceScopedJobs<Job> = { jobs: new Map() };
        state = reduceInstanceScopedJobs(state, { type: "ready", instanceId: "a" }, options);
        state = reduceInstanceScopedJobs(state, upsert("a", "one"), options);
        state = reduceInstanceScopedJobs(state, { type: "ready", instanceId: "b" }, options);
        state = reduceInstanceScopedJobs(state, upsert("b", "two"), options);
        expect(state.instanceId).toBe("a");
        expect([...state.jobs.keys()]).toEqual(["one"]);

        state = reduceInstanceScopedJobs(state, { type: "reset", instanceId: "b" }, options);
        expect([...state.jobs.keys()]).toEqual(["one"]);
        state = reduceInstanceScopedJobs(state, { type: "reset", instanceId: "a" }, options);
        expect(state.jobs.size).toBe(0);
        expect(state.acceptingInstance).toBe(true);

        state = reduceInstanceScopedJobs(state, upsert("a", "late"), options);
        expect(state.jobs.size).toBe(0);
        state = reduceInstanceScopedJobs(state, { type: "ready", instanceId: "b" }, options);
        state = reduceInstanceScopedJobs(state, upsert("b", "two"), options);
        expect(state.instanceId).toBe("b");
        expect([...state.jobs.keys()]).toEqual(["two"]);
    });

    test("caps tracked Jobs, still updates a tracked Job at the cap, and frees a slot on remove", () => {
        let state: InstanceScopedJobs<Job> = { jobs: new Map() };
        state = reduceInstanceScopedJobs(state, { type: "ready", instanceId: "a" }, options);
        state = reduceInstanceScopedJobs(state, upsert("a", "one"), options);
        state = reduceInstanceScopedJobs(state, upsert("a", "two"), options);
        const full = reduceInstanceScopedJobs(state, upsert("a", "three"), options);
        expect(full).toBe(state);

        state = reduceInstanceScopedJobs(state, upsert("a", "two", "succeeded"), options);
        expect(state.jobs.get("two")?.status).toBe("succeeded");
        state = reduceInstanceScopedJobs(
            state,
            { type: "remove", instanceId: "a", job: { id: "two", status: "" } },
            options,
        );
        state = reduceInstanceScopedJobs(state, upsert("a", "three"), options);
        expect([...state.jobs.keys()]).toEqual(["one", "three"]);
    });

    test("returns the same state when the route does not match", () => {
        const state: InstanceScopedJobs<Job> = { jobs: new Map() };
        const next = reduceInstanceScopedJobs(
            state,
            { type: "ready", instanceId: "a" },
            { ...options, routeMatches: false },
        );
        expect(next).toBe(state);
    });
});
