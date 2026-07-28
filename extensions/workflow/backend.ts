import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AbortableSemaphore } from "../subagent/semaphore.js";
import {
    MAX_WORKFLOW_ID,
    type WorkflowAgentSummaryV1,
    type WorkflowRunSummaryV1,
    type WorkflowUsageV1,
} from "./protocol.js";
import type { WorkflowRunStorage } from "./run-storage.js";
import { executableWorkflowScript } from "./storage.js";
import { WorkflowWorktreeManager } from "./worktree.js";

export const DEFAULT_WORKFLOW_LIMITS = {
    maxConcurrency: 4,
    maxAgents: 1_000,
    timeoutMs: 10 * 60_000,
    maxTokens: 0,
    maxCost: 0,
} as const;
const MAX_SCRIPT_BYTES = 64 * 1024,
    MAX_FRAME_BYTES = 256 * 1024,
    MAX_PENDING = 16,
    STDERR_BYTES = 8 * 1024;
const READY_TIMEOUT_MS = 5_000,
    HEARTBEAT_TIMEOUT_MS = 5_000,
    LARGE_RUN_WARNING_AGENTS = 25;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const INTERRUPTION_WARNING = "Workflow interrupted by host shutdown; resume after restart.";

export interface AgentRequest {
    prompt: string;
    role: string;
    model?: string;
    schema?: Record<string, unknown>;
    signal: AbortSignal;
    timeoutMs: number;
    cwd: string;
}
export interface AgentResult {
    value: unknown;
    usage?: Partial<WorkflowUsageV1>;
}
export type AgentExecutor = (request: AgentRequest) => Promise<AgentResult>;
export interface WorkflowLaunch {
    name: string;
    script: string;
    args?: unknown;
    sessionId: string;
    cwd: string;
    limits?: Partial<typeof DEFAULT_WORKFLOW_LIMITS>;
    parentRunId?: string;
    /** Internal replay seed, journaled before the new run executes. */
    seedCompletions?: ReadonlyMap<string, unknown>;
}
export interface WorkflowHostPolicy {
    roles?: readonly string[];
    allowUnsafeSharedCheckout?: boolean;
    models?: readonly string[];
    resolveModel?: (role: string, requested?: string) => string | undefined;
}
export interface WorkflowBackendOptions {
    agentExecutor: AgentExecutor;
    nodePath?: string;
    environment?: NodeJS.ProcessEnv;
    eventSink?: (run: WorkflowRunSummaryV1) => void;
    now?: () => number;
    policy?: WorkflowHostPolicy;
    runTimeoutMs?: number;
    watchdogMs?: number;
    /** True for executors (such as runSubagent) that honor abort and reap their child process. */
    cooperativeExecutor?: boolean;
    shutdownGraceMs?: number;
    storage?: WorkflowRunStorage;
    worktreeManager?: WorkflowWorktreeManager;
    /** Test-only fault injection, called after an operation is durable but before replying. */
    afterDurableCompletion?: (operationId: string) => Promise<void> | void;
}
export interface WorkflowBackend {
    launch(input: WorkflowLaunch): Promise<{ runId: string }>;
    initialize?(cwd: string): Promise<WorkflowRunSummaryV1[]>;
    recover?(id: string): Promise<void>;
    list(): WorkflowRunSummaryV1[];
    inspect(id: string): { run: WorkflowRunSummaryV1; script: string; result?: string };
    subscribe(listener: (run: WorkflowRunSummaryV1) => void): () => void;
    control(
        id: string,
        control:
            | "pause"
            | "resume"
            | "stop"
            | "restart-agent"
            | "retry"
            | { action: "pause" | "resume" | "stop" | "restart-agent" | "retry"; agentId?: string },
    ): Promise<{ runId?: string } | undefined>;
    claimTerminalDelivery?(id: string): Promise<boolean>;
    markTerminalDelivered?(id: string): Promise<void>;
    releaseTerminalDelivery?(id: string): Promise<void>;
    shutdown(): Promise<void>;
}
interface ActiveRun {
    summary: WorkflowRunSummaryV1;
    script: string;
    controller: AbortController;
    child?: ReturnType<typeof spawn>;
    result?: string;
    settlement: Promise<void>;
    cooperativeTasks: Set<Promise<unknown>>;
    directory?: string;
    completions: Map<string, unknown>;
    paused: boolean;
    resumeWaiters: (() => void)[];
    persistence: Promise<void>;
    input: WorkflowLaunch;
    semaphore: AbortableSemaphore;
    activeSharedWriters: number;
    interrupted?: boolean;
    stopping?: boolean;
}

const emptyUsage = (): WorkflowUsageV1 => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
});
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const bounded = (value: unknown) => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Workflow values must be JSON serializable.");
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("Workflow RPC value exceeds the 256 KiB limit.");
    return text;
};
const addUsage = (target: WorkflowUsageV1, value: Partial<WorkflowUsageV1> = {}) => {
    for (const key of Object.keys(target) as (keyof WorkflowUsageV1)[]) target[key] += Number(value[key]) || 0;
};

export function preflightWorkflow(script: string): { phases: string[]; agents: number } {
    if (!script.trim()) throw new Error("Workflow script must not be empty.");
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error("Workflow script exceeds the 64 KiB limit.");
    const executable = executableWorkflowScript(script);
    // Defense in depth only: process isolation, Node permissions, a stripped realm, and host validation
    // remain authoritative. Reject obvious and obfuscated ambient-authority probes before approval.
    const forbidden =
        /(?:\b(?:process|require|eval|Function|WebSocket|fetch|XMLHttpRequest|Deno|Bun|child_process)\b|\bimport\b|\bexport\s|__proto__)/;
    if (forbidden.test(executable)) throw new Error("Workflow script uses a forbidden runtime capability.");
    return {
        phases: [...executable.matchAll(/\bphase\s*\(\s*(["'`])([^"'`]{1,512})\1/g)]
            .map((m) => m[2] ?? "")
            .slice(0, 100),
        agents: [...executable.matchAll(/\bagent\s*\(/g)].length,
    };
}
async function commandVersion(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: environment });
        let output = "",
            settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve(output.trim());
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("version probe timed out"));
        }, 2_000);
        child.stdout.on("data", (c) => {
            output = `${output}${c}`.slice(0, 1024);
        });
        child.once("error", (e) => finish(e));
        child.once("close", (code) => finish(code === 0 ? undefined : new Error(`exit code ${code}`)));
    });
}
export async function resolveWorkflowNode(
    options: { environment?: NodeJS.ProcessEnv; configuredPath?: string } = {},
): Promise<string> {
    const env = options.environment ?? process.env,
        failures: string[] = [];
    for (const [source, candidate] of [
        ["PUI_WORKFLOW_NODE", env.PUI_WORKFLOW_NODE],
        ["configured path", options.configuredPath],
        ["PATH", "node"],
    ] as const) {
        if (!candidate) continue;
        try {
            const version = await commandVersion(candidate, env),
                match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
            if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19))
                throw new Error(`found ${version}; need >=22.19.0`);
            if (candidate.includes(path.sep)) return await realpath(candidate);
            const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
            for (const directory of (env.PATH ?? "").split(path.delimiter))
                for (const extension of extensions) {
                    const located = path.join(directory || ".", `${candidate}${extension}`);
                    try {
                        await fs.promises.access(located, fs.constants.X_OK);
                        return await realpath(located);
                    } catch {}
                }
            return candidate;
        } catch (e) {
            failures.push(`${source} (${candidate}): ${errorMessage(e)}`);
        }
    }
    throw new Error(
        `Workflows require an external Node >=22.19. Set PUI_WORKFLOW_NODE. Attempts: ${failures.join("; ") || "none"}`,
    );
}
function schemaValid(value: unknown, schema: unknown): boolean {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
    const s = schema as Record<string, unknown>;
    if (s.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const o = value as Record<string, unknown>;
        if (Array.isArray(s.required) && !s.required.every((k) => typeof k === "string" && k in o)) return false;
        if (s.properties && typeof s.properties === "object")
            for (const [k, child] of Object.entries(s.properties))
                if (k in o && !schemaValid(o[k], child)) return false;
    } else if (s.type === "array") return Array.isArray(value) && value.every((v) => schemaValid(v, s.items));
    else if (s.type === "string") return typeof value === "string";
    else if (s.type === "number") return typeof value === "number";
    else if (s.type === "boolean") return typeof value === "boolean";
    return true;
}

// The only cross-realm value retained by VM code is this closure's bridge. Its callable wrappers
// and every value visible to workflow code are created by the context itself.
const BOOTSTRAP_SOURCE = `(()=>{const bridge=__bridge,parse=JSON.parse,stringify=JSON.stringify,occ=new Map(),call=(method,value,identity)=>Promise.resolve(bridge(stringify({method,value,identity}))).then(parse);globalThis.phase=n=>call("phase",{name:n});globalThis.log=x=>call("log",{message:String(x)});globalThis.agent=(prompt,options={})=>{const site=String(new Error().stack||"").split("\\n")[2]?.trim().slice(0,512)||"unknown",n=(occ.get(site)||0)+1;occ.set(site,n);return call("agent",{prompt,options},site+"#"+n)};globalThis.parallel=x=>Array.isArray(x)?Promise.all(x):Promise.all(Object.entries(x).map(async([k,v])=>[k,await v])).then(Object.fromEntries);globalThis.pipeline=async(items,fn,options={})=>{const out=new Array(items.length),limit=Math.max(1,Math.min(16,options.concurrency||4));let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}));return out};globalThis.args=parse(__args);delete globalThis.__bridge;delete globalThis.__args})()`;
const WORKER_SOURCE = String.raw`import vm from "node:vm";
const send=v=>process.stdout.write(JSON.stringify({v:1,...v})+"\n");let buffer="",next=0;const pending=new Map();
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>262144)process.exit(72);let i;while((i=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let m;try{m=JSON.parse(line)}catch{process.exit(73)}if(m.v!==1)process.exit(74);if(m.t==="start")void run(m);else if(m.t==="reply"){const p=pending.get(m.id);if(p){pending.delete(m.id);m.ok?p.resolve(m.json):p.reject(String(m.error).slice(0,2000))}}}});
const host=json=>new Promise((resolve,reject)=>{let request;try{request=JSON.parse(json)}catch(e){reject(e);return}const id=String(++next);pending.set(id,{resolve,reject});send({t:"rpc",id,...request})});
async function run(m){const context=vm.createContext({__bridge:host,__args:JSON.stringify(m.args??null)},{codeGeneration:{strings:false,wasm:false}});new vm.Script(${JSON.stringify(BOOTSTRAP_SOURCE)}).runInContext(context);try{const result=await new vm.Script('(async()=>{'+m.script+'\n})()',{timeout:1000}).runInContext(context,{timeout:1000});send({t:"terminal",ok:true,json:JSON.stringify(result)})}catch(e){send({t:"terminal",ok:false,error:String(e?.message||e)})}}send({t:"ready"});setInterval(()=>send({t:"heartbeat"}),1000).unref();`;

export function createWorkflowBackend(options: WorkflowBackendOptions): WorkflowBackend {
    const runs = new Map<string, ActiveRun>(),
        listeners = new Set<(run: WorkflowRunSummaryV1) => void>(),
        worktrees =
            options.worktreeManager ??
            new WorkflowWorktreeManager(
                options.storage
                    ? path.join(path.dirname(options.storage.root), "workflow-worktrees")
                    : path.join(os.homedir(), ".pi", "agent", "workflow-worktrees"),
            );
    let shuttingDown = false;
    const now = options.now ?? Date.now;
    const persist = (a: ActiveRun, write: () => Promise<void>) => (a.persistence = a.persistence.then(write, write));
    const publish = (a: ActiveRun) => {
        // Shutdown owns the final recoverable snapshot; late RPC cleanup must not replace it.
        if (a.interrupted) return;
        a.summary.updatedAt = now();
        const copy = structuredClone(a.summary);
        options.eventSink?.(copy);
        for (const listener of listeners) listener(copy);
        const directory = a.directory;
        const storage = options.storage;
        if (directory && storage)
            void persist(a, () => storage.snapshot(directory, copy)).catch((error) =>
                console.error(`Workflow snapshot persistence failed: ${errorMessage(error)}`),
            );
    };
    const waitWhilePaused = async (active: ActiveRun) => {
        while (active.paused)
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(new Error("Workflow stopped while paused."));
                active.controller.signal.addEventListener("abort", abort, { once: true });
                active.resumeWaiters.push(() => {
                    active.controller.signal.removeEventListener("abort", abort);
                    resolve();
                });
            });
    };
    const finishPhase = (a: ActiveRun, status: "succeeded" | "failed" | "cancelled", error?: string) => {
        const phase = a.summary.phases.find((p) => p.id === a.summary.currentPhase);
        if (phase?.status === "running") {
            phase.status = status;
            phase.endedAt = phase.updatedAt = now();
            if (error) phase.error = error;
        }
    };
    const execute = async (active: ActiveRun, input: WorkflowLaunch, node: string) => {
        let directory: string | undefined,
            terminal = false,
            stderr = "";
        const finish = (status: "succeeded" | "failed" | "cancelled", error?: string, json?: string) => {
            if (terminal || active.interrupted) return;
            terminal = true;
            active.summary.status = status;
            active.summary.endedAt = now();
            if (error) active.summary.error = error.slice(0, 2000);
            if (json !== undefined) active.result = json;
            finishPhase(active, status, error);
            publish(active);
            const activeDirectory = active.directory;
            const storage = options.storage;
            if (activeDirectory && storage)
                void persist(active, () =>
                    storage.terminal(
                        activeDirectory,
                        json === undefined ? null : JSON.parse(json),
                        structuredClone(active.summary),
                    ),
                ).catch((e) => console.error(`Workflow terminal persistence failed: ${errorMessage(e)}`));
        };
        try {
            directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-"));
            const worker = path.join(directory, "worker.mjs");
            await fs.promises.writeFile(worker, WORKER_SOURCE, { mode: 0o600 });
            const canonical = await realpath(worker);
            const child = spawn(
                node,
                ["--permission", `--allow-fs-read=${canonical}`, "--max-old-space-size=128", canonical],
                { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: {} },
            );
            active.child = child;
            const terminate = () => {
                try {
                    process.platform !== "win32" && child.pid
                        ? process.kill(-child.pid, "SIGTERM")
                        : child.kill("SIGTERM");
                } catch {}
                setTimeout(() => {
                    try {
                        process.platform !== "win32" && child.pid
                            ? process.kill(-child.pid, "SIGKILL")
                            : child.kill("SIGKILL");
                    } catch {}
                }, 500).unref();
            };
            active.controller.signal.addEventListener("abort", terminate, { once: true });
            if (active.controller.signal.aborted) terminate();
            else {
                active.summary.status = "running";
                active.summary.startedAt = now();
                publish(active);
            }
            if (!child.stdin || !child.stdout) throw new Error("Workflow worker pipes were not created.");
            let buffer = "",
                pending = 0,
                agents = 0,
                phaseId: string | undefined,
                ready = false,
                lastBeat = now();
            const send = (frame: unknown) => child.stdin.write(`${bounded(frame)}\n`);
            const tracked = <T>(p: Promise<T>) => p;
            const handle = async (inputFrame: unknown) => {
                if (!inputFrame || typeof inputFrame !== "object" || Array.isArray(inputFrame))
                    throw new Error("Malformed workflow worker frame.");
                const frame = inputFrame as Record<string, unknown>;
                if (frame.v !== 1 || typeof frame.t !== "string") throw new Error("Malformed workflow worker frame.");
                if (frame.t === "ready") {
                    ready = true;
                    lastBeat = now();
                    send({ v: 1, t: "start", script: executableWorkflowScript(input.script), args: input.args });
                    return;
                }
                if (frame.t === "heartbeat") {
                    lastBeat = now();
                    return;
                }
                if (frame.t === "terminal") {
                    if (frame.json !== undefined && typeof frame.json !== "string")
                        throw new Error("Malformed workflow result.");
                    if (typeof frame.json === "string" && Buffer.byteLength(frame.json) > MAX_FRAME_BYTES)
                        throw new Error("Oversized workflow result.");
                    frame.ok === true
                        ? finish("succeeded", undefined, frame.json as string | undefined)
                        : finish("failed", String(frame.error));
                    child.stdin.end();
                    child.kill("SIGTERM");
                    return;
                }
                if (
                    frame.t !== "rpc" ||
                    typeof frame.id !== "string" ||
                    typeof frame.method !== "string" ||
                    ++pending > MAX_PENDING
                )
                    throw new Error("Invalid or excessive workflow RPC request.");
                try {
                    let value: unknown = null;
                    if (frame.method === "phase") {
                        finishPhase(active, "succeeded");
                        const data =
                                frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
                                    ? (frame.value as Record<string, unknown>)
                                    : {},
                            name = String(data.name ?? "").slice(0, 512);
                        if (!name) throw new Error("Invalid phase");
                        phaseId = `phase-${active.summary.phases.length + 1}`;
                        active.summary.currentPhase = phaseId;
                        active.summary.phases.push({
                            id: phaseId,
                            name,
                            status: "running",
                            startedAt: now(),
                            updatedAt: now(),
                            agentIds: [],
                        });
                        publish(active);
                    } else if (frame.method === "log") {
                        const data =
                            frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
                                ? (frame.value as Record<string, unknown>)
                                : {};
                        active.summary.recentActivity.push({
                            sequence: (active.summary.recentActivity.at(-1)?.sequence ?? 0) + 1,
                            timestamp: now(),
                            kind: "log",
                            title: String(data.message ?? "").slice(0, 2000),
                        });
                        active.summary.recentActivity = active.summary.recentActivity.slice(-20);
                        publish(active);
                    } else if (frame.method === "agent") {
                        if (++agents > active.summary.limits.maxAgents) throw new Error("Workflow agent cap exceeded.");
                        if (agents === LARGE_RUN_WARNING_AGENTS) {
                            active.summary.warning = `Large workflow run: ${LARGE_RUN_WARNING_AGENTS} agents scheduled.`;
                            publish(active);
                        }
                        if (
                            typeof frame.identity !== "string" ||
                            frame.identity.length > 1024 ||
                            !frame.identity.includes("#")
                        )
                            throw new Error("Invalid workflow operation identity.");
                        // Stable across hosts and runtimes while remaining bounded by the protocol.
                        const operationId = `agent-${createHash("sha256").update(frame.identity).digest("hex")}`.slice(
                            0,
                            MAX_WORKFLOW_ID,
                        );
                        if (active.completions.has(operationId)) {
                            value = structuredClone(active.completions.get(operationId));
                            send({ v: 1, t: "reply", id: frame.id, ok: true, json: bounded(value) });
                            return;
                        }
                        await waitWhilePaused(active);
                        if (!frame.value || typeof frame.value !== "object" || Array.isArray(frame.value))
                            throw new Error("Invalid agent request.");
                        const request = frame.value as Record<string, unknown>,
                            prompt = request.prompt,
                            rawOptions = request.options;
                        if (
                            typeof prompt !== "string" ||
                            !prompt.trim() ||
                            Buffer.byteLength(prompt) > 8000 ||
                            !rawOptions ||
                            typeof rawOptions !== "object" ||
                            Array.isArray(rawOptions)
                        )
                            throw new Error("Invalid agent request.");
                        const opts = rawOptions as Record<string, unknown>;
                        if (
                            Object.keys(opts).some(
                                (key) =>
                                    !["label", "role", "model", "schema", "retries", "timeoutMs", "isolation"].includes(
                                        key,
                                    ),
                            ) ||
                            (opts.label !== undefined && typeof opts.label !== "string") ||
                            (opts.role !== undefined && typeof opts.role !== "string") ||
                            (opts.model !== undefined && typeof opts.model !== "string") ||
                            (opts.schema !== undefined &&
                                (!opts.schema || typeof opts.schema !== "object" || Array.isArray(opts.schema))) ||
                            (opts.retries !== undefined &&
                                (!Number.isInteger(opts.retries) || (opts.retries as number) < 0)) ||
                            (opts.timeoutMs !== undefined &&
                                (!Number.isFinite(opts.timeoutMs) || (opts.timeoutMs as number) <= 0))
                        )
                            throw new Error("Invalid or unknown agent option.");
                        bounded(opts);
                        const role = typeof opts.role === "string" ? opts.role : "generic",
                            isolation = opts.isolation,
                            schema = opts.schema as Record<string, unknown> | undefined;
                        if (isolation !== undefined && isolation !== "worktree")
                            throw new Error(`Unknown agent isolation: ${String(isolation)}`);
                        const writeCapable = role !== "explore" && role !== "read-only";
                        if (
                            writeCapable &&
                            isolation !== "worktree" &&
                            active.activeSharedWriters > 0 &&
                            !options.policy?.allowUnsafeSharedCheckout
                        )
                            throw new Error("Concurrent write-capable agents require worktree isolation.");
                        if (options.policy?.roles && !options.policy.roles.includes(role))
                            throw new Error(`Agent role is not allowed by host policy: ${role}`);
                        const model =
                            options.policy?.resolveModel?.(
                                role,
                                typeof opts.model === "string" ? opts.model : undefined,
                            ) ?? (typeof opts.model === "string" ? opts.model : undefined);
                        if (model && options.policy?.models && !options.policy.models.includes(model))
                            throw new Error(`Agent model is not allowed by host policy: ${model}`);
                        const agent: WorkflowAgentSummaryV1 = {
                            id: operationId,
                            label: String(opts.label || prompt).slice(0, 512),
                            role,
                            ...(model ? { model } : {}),
                            status: "running",
                            phaseId,
                            startedAt: now(),
                            updatedAt: now(),
                            usage: emptyUsage(),
                            prompt: prompt.slice(0, 8000),
                            recentActivity: [],
                        };
                        active.summary.agents.push(agent);
                        if (phaseId) active.summary.phases.find((p) => p.id === phaseId)?.agentIds.push(agent.id);
                        publish(active);
                        const release = await active.semaphore.acquire(active.controller.signal);
                        let sharedWriter = false;
                        try {
                            if (writeCapable && isolation !== "worktree") {
                                if (active.activeSharedWriters > 0 && !options.policy?.allowUnsafeSharedCheckout)
                                    throw new Error("Concurrent write-capable agents require worktree isolation.");
                                active.activeSharedWriters++;
                                sharedWriter = true;
                            }
                            await waitWhilePaused(active);
                            const timeoutMs = Math.min(
                                    DEFAULT_WORKFLOW_LIMITS.timeoutMs,
                                    Math.max(1, Number(opts.timeoutMs) || DEFAULT_WORKFLOW_LIMITS.timeoutMs),
                                ),
                                controller = new AbortController(),
                                signal = AbortSignal.any([active.controller.signal, controller.signal]);
                            let timer: NodeJS.Timeout | undefined;
                            const timeout = new Promise<never>((_, reject) => {
                                timer = setTimeout(() => {
                                    controller.abort();
                                    reject(new Error("Agent timed out."));
                                }, timeoutMs);
                            });
                            let owned: Awaited<ReturnType<WorkflowWorktreeManager["create"]>> | undefined,
                                operationKey: string | undefined;
                            try {
                                if (isolation === "worktree") {
                                    operationKey = `${operationId.slice(0, 35)}-${crypto.randomUUID().slice(0, 8)}`;
                                    owned = await worktrees.create(
                                        input.cwd,
                                        active.summary.id.slice(0, 63),
                                        operationKey,
                                    );
                                    if (active.directory && options.storage)
                                        await options.storage.worktree(active.directory, operationKey, owned, now());
                                    agent.worktree = { cwd: owned.cwd, branch: owned.branch };
                                    agent.recentActivity.push({
                                        sequence: 1,
                                        timestamp: now(),
                                        kind: "diagnostic",
                                        title: `Worktree ${owned.branch} at ${owned.cwd}`.slice(0, 2000),
                                    });
                                    publish(active);
                                }
                                let result: AgentResult | undefined;
                                const retries = Math.min(3, Math.max(0, Number(opts.retries) || 0));
                                for (let attempt = 0; attempt <= retries; attempt++)
                                    try {
                                        const operation = Promise.resolve(
                                            options.agentExecutor({
                                                prompt,
                                                role,
                                                model,
                                                schema,
                                                signal,
                                                timeoutMs,
                                                cwd: owned?.cwd ?? input.cwd,
                                            }),
                                        );
                                        if (options.cooperativeExecutor) {
                                            active.cooperativeTasks.add(operation);
                                            operation
                                                .finally(() => active.cooperativeTasks.delete(operation))
                                                .catch(() => {});
                                        }
                                        result = await Promise.race([operation, timeout]);
                                        if (!schemaValid(result.value, schema))
                                            throw new Error("Agent result does not match schema.");
                                        break;
                                    } catch (e) {
                                        if (attempt === retries || signal.aborted) throw e;
                                    }
                                if (!result) throw new Error("Agent produced no result.");
                                value = result.value;
                                bounded(value);
                                const nextTokens =
                                        active.summary.usage.totalTokens + (Number(result.usage?.totalTokens) || 0),
                                    nextCost = active.summary.usage.cost + (Number(result.usage?.cost) || 0);
                                addUsage(agent.usage, result.usage);
                                addUsage(active.summary.usage, result.usage);
                                if (active.summary.limits.maxTokens && nextTokens > active.summary.limits.maxTokens)
                                    throw new Error(
                                        `Workflow token budget exceeded (${nextTokens}/${active.summary.limits.maxTokens}).`,
                                    );
                                if (active.summary.limits.maxCost && nextCost > active.summary.limits.maxCost)
                                    throw new Error(
                                        `Workflow cost budget exceeded (${nextCost}/${active.summary.limits.maxCost}).`,
                                    );
                                if (active.directory)
                                    await options.storage?.complete(active.directory, operationId, value, now());
                                active.completions.set(operationId, structuredClone(value));
                                await options.afterDurableCompletion?.(operationId);
                                agent.status = "succeeded";
                            } finally {
                                if (timer) clearTimeout(timer);
                                if (owned) {
                                    await worktrees.cleanup(input.cwd, owned);
                                    if (operationKey && active.directory && options.storage)
                                        await options.storage.worktree(active.directory, operationKey, null, now());
                                }
                            }
                        } catch (e) {
                            agent.status = active.controller.signal.aborted
                                ? "cancelled"
                                : errorMessage(e).includes("timed out")
                                  ? "timed_out"
                                  : "failed";
                            agent.error = errorMessage(e).slice(0, 2000);
                            throw e;
                        } finally {
                            if (sharedWriter) active.activeSharedWriters--;
                            agent.endedAt = agent.updatedAt = now();
                            publish(active);
                            release();
                        }
                    } else throw new Error(`Unknown workflow RPC method: ${frame.method}`);
                    send({ v: 1, t: "reply", id: frame.id, ok: true, json: bounded(value) });
                } catch (e) {
                    send({ v: 1, t: "reply", id: frame.id, ok: false, error: errorMessage(e).slice(0, 2000) });
                } finally {
                    pending--;
                }
            };
            child.stderr?.on("data", (c) => {
                stderr = Buffer.from(`${stderr}${c}`).subarray(-STDERR_BYTES).toString();
            });
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                buffer += chunk;
                if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
                    finish("failed", "Oversized workflow worker frame.");
                    active.controller.abort();
                    return;
                }
                let index = buffer.indexOf("\n");
                while (index >= 0) {
                    const line = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    index = buffer.indexOf("\n");
                    try {
                        void tracked(handle(JSON.parse(line))).catch((e) => {
                            finish("failed", errorMessage(e));
                            active.controller.abort();
                        });
                    } catch {
                        finish("failed", "Malformed workflow worker output.");
                        active.controller.abort();
                    }
                }
            });
            const watchdog = setInterval(() => {
                const limit = ready ? (options.watchdogMs ?? HEARTBEAT_TIMEOUT_MS) : READY_TIMEOUT_MS;
                if (now() - lastBeat > limit) {
                    finish(
                        "failed",
                        ready ? "Workflow worker heartbeat timed out." : "Workflow worker did not become ready.",
                    );
                    active.controller.abort();
                }
            }, 250);
            const total = setTimeout(() => {
                finish("failed", "Workflow run timed out.");
                active.controller.abort();
            }, options.runTimeoutMs ?? active.summary.limits.timeoutMs);
            await new Promise<void>((resolve) => {
                child.once("error", (e) => {
                    finish("failed", errorMessage(e));
                    resolve();
                });
                child.once("close", () => {
                    if (!terminal)
                        finish(
                            active.controller.signal.aborted ? "cancelled" : "failed",
                            active.controller.signal.aborted
                                ? undefined
                                : `Workflow worker exited without a terminal result.${stderr ? ` ${stderr}` : ""}`,
                        );
                    resolve();
                });
            });
            clearInterval(watchdog);
            clearTimeout(total);
        } catch (e) {
            finish(active.controller.signal.aborted ? "cancelled" : "failed", errorMessage(e));
        } finally {
            active.child = undefined;
            await active.persistence;
            if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
        }
    };
    return {
        async launch(input) {
            if (shuttingDown) throw new Error("Workflow backend is shutting down.");
            preflightWorkflow(input.script);
            input = { ...input, cwd: await worktrees.repository(input.cwd).catch(async () => realpath(input.cwd)) };
            const node = await resolveWorkflowNode({
                    environment: options.environment,
                    configuredPath: options.nodePath,
                }),
                id = crypto.randomUUID(),
                timestamp = now(),
                controller = new AbortController(),
                requested = input.limits ?? {},
                limits = {
                    maxConcurrency: Math.min(
                        16,
                        Math.max(1, Number(requested.maxConcurrency) || DEFAULT_WORKFLOW_LIMITS.maxConcurrency),
                    ),
                    maxAgents: Math.min(
                        1_000,
                        Math.max(1, Number(requested.maxAgents) || DEFAULT_WORKFLOW_LIMITS.maxAgents),
                    ),
                    timeoutMs: Math.max(1, Number(requested.timeoutMs) || DEFAULT_WORKFLOW_LIMITS.timeoutMs),
                    maxTokens: Math.max(0, Number(requested.maxTokens) || 0),
                    maxCost: Math.max(0, Number(requested.maxCost) || 0),
                };
            const summary: WorkflowRunSummaryV1 = {
                schema: "pi.workflow",
                version: 1,
                id,
                name: input.name,
                sessionId: input.sessionId,
                cwd: input.cwd,
                status: "queued",
                phases: [],
                agents: [],
                usage: emptyUsage(),
                limits,
                recentActivity: [],
                updatedAt: timestamp,
            };
            const active: ActiveRun = {
                summary,
                script: input.script,
                controller,
                settlement: Promise.resolve(),
                cooperativeTasks: new Set(),
                completions: new Map(input.seedCompletions ?? []),
                paused: false,
                resumeWaiters: [],
                persistence: Promise.resolve(),
                input: { ...input, limits: input.limits },
                semaphore: new AbortableSemaphore(limits.maxConcurrency),
                activeSharedWriters: 0,
            };
            if (options.storage)
                active.directory = await options.storage.create(
                    input.cwd,
                    id,
                    {
                        name: input.name,
                        sessionId: input.sessionId,
                        cwd: await realpath(input.cwd),
                        script: input.script,
                        args: input.args,
                        policy: options.policy ?? {},
                        roles: options.policy?.roles ?? [],
                        models: options.policy?.models ?? [],
                        limits,
                        parentRunId: input.parentRunId,
                    },
                    summary,
                );
            if (active.directory && options.storage)
                for (const [operation, value] of active.completions)
                    await options.storage.complete(active.directory, operation, value, now());
            runs.set(id, active);
            publish(active);
            active.settlement = execute(active, input, node).catch((e) => {
                if (!TERMINAL.has(active.summary.status)) {
                    active.summary.status = "failed";
                    active.summary.error = errorMessage(e);
                    publish(active);
                }
            });
            return { runId: id };
        },
        async initialize(cwd) {
            if (!options.storage) return [];
            for (const stored of await options.storage.discover(cwd)) {
                if (runs.has(stored.id)) continue;
                for (const [operation, owned] of stored.worktrees) {
                    await worktrees.cleanup(stored.launch.cwd, owned);
                    await options.storage.worktree(stored.directory, operation, null, now());
                }
                const controller = new AbortController(),
                    limits = { ...DEFAULT_WORKFLOW_LIMITS, ...(stored.launch.limits as object) };
                const summary = structuredClone(stored.snapshot);
                if (!TERMINAL.has(summary.status)) {
                    // A snapshot can lag the journal. Keep only durable agents and rebuild references;
                    // replay will recreate every interrupted operation with the same stable identity.
                    summary.agents = summary.agents
                        .filter((agent) => stored.completions.has(agent.id))
                        .map((agent) => ({ ...agent, status: "succeeded" as const, error: undefined }));
                    const durable = new Set(summary.agents.map((agent) => agent.id));
                    summary.phases = summary.phases.map((phase) => ({
                        ...phase,
                        status: phase.status === "running" ? "queued" : phase.status,
                        agentIds: phase.agentIds.filter((agentId) => durable.has(agentId)),
                    }));
                    summary.currentPhase = undefined;
                    summary.endedAt = undefined;
                    summary.error = undefined;
                }
                runs.set(stored.id, {
                    summary,
                    script: stored.launch.script,
                    controller,
                    settlement: Promise.resolve(),
                    cooperativeTasks: new Set(),
                    directory: stored.corrupt ? undefined : stored.directory,
                    completions: new Map(stored.completions),
                    paused: true,
                    resumeWaiters: [],
                    persistence: Promise.resolve(),
                    input: {
                        name: stored.launch.name,
                        script: stored.launch.script,
                        args: stored.launch.args,
                        sessionId: stored.launch.sessionId,
                        cwd: stored.launch.cwd,
                        limits,
                        parentRunId: stored.launch.parentRunId,
                    },
                    semaphore: new AbortableSemaphore(limits.maxConcurrency),
                    activeSharedWriters: 0,
                    ...(stored.result !== undefined ? { result: stored.result } : {}),
                });
            }
            return this.list();
        },
        async recover(id) {
            const active = runs.get(id);
            if (!active) throw new Error(`Unknown workflow run: ${id}`);
            if (TERMINAL.has(active.summary.status)) return;
            if (!active.paused) throw new Error("Workflow recovery is already running.");
            active.paused = false;
            active.summary.status = "queued";
            if (active.summary.warning === INTERRUPTION_WARNING) active.summary.warning = undefined;
            const node = await resolveWorkflowNode({
                environment: options.environment,
                configuredPath: options.nodePath,
            });
            active.settlement = execute(active, active.input, node);
        },
        list: () => [...runs.values()].map((r) => structuredClone(r.summary)),
        inspect(id) {
            const r = runs.get(id);
            if (!r) throw new Error(`Unknown workflow run: ${id}`);
            return {
                run: structuredClone(r.summary),
                script: r.script,
                ...(r.result !== undefined ? { result: r.result } : {}),
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async control(id, requestedControl) {
            const action = typeof requestedControl === "string" ? requestedControl : requestedControl.action;
            const run = runs.get(id);
            if (!run) throw new Error(`Unknown workflow run: ${id}`);
            if (action === "stop") {
                if (TERMINAL.has(run.summary.status)) return;
                run.stopping = true;
                run.controller.abort();
                if (!run.child) {
                    run.summary.status = "cancelled";
                    run.summary.endedAt = now();
                    publish(run);
                    const runDirectory = run.directory;
                    const storage = options.storage;
                    if (runDirectory && storage)
                        await persist(run, () => storage.terminal(runDirectory, null, structuredClone(run.summary)));
                }
            } else if (action === "pause") {
                if (run.summary.status !== "running") throw new Error("Only a running workflow can be paused.");
                run.paused = true;
                run.summary.status = "paused";
                publish(run);
            } else if (action === "resume") {
                if (run.summary.status !== "paused") throw new Error("Only a paused workflow can be resumed.");
                run.paused = false;
                run.summary.status = "running";
                for (const wake of run.resumeWaiters.splice(0)) wake();
                publish(run);
            } else if (action === "retry") {
                if (!TERMINAL.has(run.summary.status)) throw new Error("Only a terminal workflow can be retried.");
                // Retry is expected replay: reuse every durable completion.
                return this.launch({ ...run.input, parentRunId: run.summary.id, seedCompletions: run.completions });
            } else if (action === "restart-agent") {
                if (!TERMINAL.has(run.summary.status))
                    throw new Error("Only a terminal workflow can restart an agent.");
                const agentId = typeof requestedControl === "object" ? requestedControl.agentId : undefined;
                if (
                    !agentId ||
                    !run.summary.agents.some((agent) => agent.id === agentId) ||
                    !run.completions.has(agentId)
                )
                    throw new Error("Invalid completed agent identity.");
                const seed = new Map(run.completions);
                seed.delete(agentId);
                return this.launch({ ...run.input, parentRunId: run.summary.id, seedCompletions: seed });
            } else throw new Error(`Unknown workflow control: ${action}`);
            return {};
        },
        async claimTerminalDelivery(id) {
            const run = runs.get(id);
            if (!run?.directory || !options.storage || !TERMINAL.has(run.summary.status)) return false;
            await run.persistence;
            return options.storage.claimDelivery(run.directory);
        },
        async markTerminalDelivered(id) {
            const run = runs.get(id);
            if (!run?.directory || !options.storage) throw new Error(`Unknown durable workflow run: ${id}`);
            await options.storage.markDelivered(run.directory);
        },
        async releaseTerminalDelivery(id) {
            const run = runs.get(id);
            if (run?.directory && options.storage) await options.storage.releaseClaim(run.directory);
        },
        async shutdown() {
            if (shuttingDown) return;
            shuttingDown = true;
            const interrupted = [...runs.values()].filter((run) => !TERMINAL.has(run.summary.status) && !run.stopping);
            for (const run of interrupted) {
                run.interrupted = true;
                run.paused = true;
                run.summary.status = "paused";
                run.summary.warning = INTERRUPTION_WARNING;
                run.summary.endedAt = undefined;
                run.summary.error = undefined;
                run.summary.updatedAt = now();
                const runDirectory = run.directory;
                const storage = options.storage;
                if (runDirectory && storage)
                    await persist(run, () => storage.snapshot(runDirectory, structuredClone(run.summary)));
            }
            for (const run of interrupted) run.controller.abort();
            await Promise.allSettled([...runs.values()].map((r) => r.settlement));
            const cooperative = [...runs.values()].flatMap((r) => [...r.cooperativeTasks]);
            if (cooperative.length) {
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    Promise.allSettled(cooperative),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, options.shutdownGraceMs ?? 2_000);
                    }),
                ]);
                if (timer) clearTimeout(timer);
                if ([...runs.values()].some((r) => r.cooperativeTasks.size))
                    console.error("Workflow executor shutdown grace expired; child cleanup may be incomplete.");
            }
            listeners.clear();
        },
    };
}
