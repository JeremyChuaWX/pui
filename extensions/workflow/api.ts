/** Public, type-only API for authored workflow files. */
export interface WorkflowMetadata {
    name: string;
    description: string;
}

export interface WorkflowAgentOptions {
    label?: string;
    role?: string;
    model?: string;
    schema?: Record<string, unknown>;
    retries?: number;
    timeoutMs?: number;
    isolation?: "worktree";
}

export interface WorkflowPipelineOptions {
    concurrency?: number;
}

export interface WorkflowContext {
    readonly phase: (name: string) => Promise<void>;
    readonly log: (message: unknown) => Promise<void>;
    readonly agent: <T = unknown>(prompt: string, options?: WorkflowAgentOptions) => Promise<T>;
    readonly parallel: {
        <T>(items: readonly (T | PromiseLike<T>)[]): Promise<T[]>;
        <T extends Record<string, unknown>>(items: { [K in keyof T]: T[K] | PromiseLike<T[K]> }): Promise<T>;
    };
    readonly pipeline: <T, R>(
        items: readonly T[],
        operation: (item: T, index: number) => R | PromiseLike<R>,
        options?: WorkflowPipelineOptions,
    ) => Promise<R[]>;
}

/** Callable signature; authored files must use a named default-exported async function declaration. */
export type WorkflowFunction<Args = unknown, Result = unknown> = (
    context: WorkflowContext,
    args: Args,
) => PromiseLike<Result>;
