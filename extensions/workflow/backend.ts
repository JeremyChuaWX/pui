import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowRunSummaryV1, WorkflowUsageV1 } from "./protocol.js";

export const DEFAULT_WORKFLOW_LIMITS = {
    maxConcurrency: 4,
    maxAgents: 1_000,
    timeoutMs: 10 * 60_000,
    maxTokens: 0,
    maxCost: 0,
} as const;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING = 16;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export interface AgentRequest {
    prompt: string;
    role: string;
    model?: string;
    schema?: Record<string, unknown>;
    signal: AbortSignal;
    timeoutMs: number;
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
}
export interface WorkflowBackendOptions {
    agentExecutor: AgentExecutor;
    nodePath?: string;
    environment?: NodeJS.ProcessEnv;
    eventSink?: (run: WorkflowRunSummaryV1) => void;
    now?: () => number;
}
export interface WorkflowBackend {
    launch(input: WorkflowLaunch): Promise<{ runId: string }>;
    list(): WorkflowRunSummaryV1[];
    inspect(id: string): { run: WorkflowRunSummaryV1; script: string; result?: string };
    subscribe(listener: (run: WorkflowRunSummaryV1) => void): () => void;
    control(id: string, action: "pause" | "resume" | "stop" | "restart-agent" | "retry"): Promise<void>;
    shutdown(): Promise<void>;
}
interface ActiveRun {
    summary: WorkflowRunSummaryV1;
    script: string;
    controller: AbortController;
    child?: ReturnType<typeof spawn>;
    result?: string;
    settlement: Promise<void>;
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
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const bounded = (value: unknown) => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("Workflow RPC value exceeds the 256 KiB limit.");
    return text;
};

export function preflightWorkflow(script: string): { phases: string[]; agents: number } {
    if (!script.trim()) throw new Error("Workflow script must not be empty.");
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error("Workflow script exceeds the 64 KiB limit.");
    // Defense in depth. The external permissioned worker remains the security boundary.
    const forbidden =
        /(?:\b(?:process|require|eval|Function|WebSocket|fetch|XMLHttpRequest)\b|\bimport\s*(?:\(|["'{*])|\bexport\s|__proto__|constructor\s*\[)/;
    if (forbidden.test(script)) throw new Error("Workflow script uses a forbidden runtime capability.");
    const phases = [...script.matchAll(/\bphase\s*\(\s*(["'`])([^"'`]{1,512})\1/g)].map((match) => match[2]!);
    return { phases: phases.slice(0, 100), agents: [...script.matchAll(/\bagent\s*\(/g)].length };
}

async function commandVersion(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: environment });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk.toString()));
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`exit code ${code}`))));
    });
}
export async function resolveWorkflowNode(
    options: { environment?: NodeJS.ProcessEnv; configuredPath?: string } = {},
): Promise<string> {
    const env = options.environment ?? process.env;
    const candidates = [
        ["PUI_WORKFLOW_NODE", env.PUI_WORKFLOW_NODE],
        ["configured path", options.configuredPath],
        ["PATH", "node"],
    ] as const;
    const failures: string[] = [];
    for (const [source, candidate] of candidates) {
        if (!candidate) continue;
        try {
            const version = await commandVersion(candidate, env);
            const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
            if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19))
                throw new Error(`found ${version}; need >=22.19.0`);
            if (candidate.includes(path.sep)) return await realpath(candidate);
            const located = Bun.which(candidate);
            return located ? await realpath(located) : candidate;
        } catch (error) {
            failures.push(`${source} (${candidate}): ${message(error)}`);
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
        const object = value as Record<string, unknown>;
        if (Array.isArray(s.required) && !s.required.every((key) => typeof key === "string" && key in object))
            return false;
        if (s.properties && typeof s.properties === "object")
            for (const [key, child] of Object.entries(s.properties))
                if (key in object && !schemaValid(object[key], child)) return false;
    } else if (s.type === "array") {
        if (!Array.isArray(value) || value.some((item) => !schemaValid(item, s.items))) return false;
    } else if (s.type === "string" && typeof value !== "string") return false;
    else if (s.type === "number" && typeof value !== "number") return false;
    else if (s.type === "boolean" && typeof value !== "boolean") return false;
    return true;
}

const WORKER_SOURCE = String.raw`import vm from "node:vm";
const send=v=>process.stdout.write(JSON.stringify({v:1,...v})+"\n"); let buffer="", next=0; const pending=new Map();
process.stdin.setEncoding("utf8"); process.stdin.on("data",chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>262144)process.exit(72);let i;while((i=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let m;try{m=JSON.parse(line)}catch{process.exit(73)};if(m.v!==1)process.exit(74);if(m.t==="start")run(m);else if(m.t==="reply"){const p=pending.get(m.id);if(p){pending.delete(m.id);m.ok?p.resolve(m.value):p.reject(new Error(m.error))}}}});
const rpc=(method,value)=>new Promise((resolve,reject)=>{const id=String(++next);pending.set(id,{resolve,reject});send({t:"rpc",id,method,value})});
async function run(m){const phase=n=>rpc("phase",{name:n});const log=x=>rpc("log",{message:String(x)});const agent=(prompt,options={})=>rpc("agent",{prompt,options});const parallel=x=>Array.isArray(x)?Promise.all(x):Promise.all(Object.entries(x).map(async([k,v])=>[k,await v])).then(Object.fromEntries);const pipeline=async(items,fn,options={})=>{const out=new Array(items.length),limit=Math.max(1,Math.min(16,options.concurrency||4));let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}));return out};
const context=vm.createContext(Object.freeze({agent,pipeline,parallel,phase,log,args:Object.freeze(m.args??null),JSON,Math,Promise,Object,Array,String,Number,Boolean,undefined}),{codeGeneration:{strings:false,wasm:false}});try{const wrapped='(async()=>{'+m.script+'\n})()';const result=await new vm.Script(wrapped,{timeout:1000}).runInContext(context,{timeout:1000});send({t:"terminal",ok:true,value:result})}catch(e){send({t:"terminal",ok:false,error:String(e?.message||e)})}}send({t:"ready"});setInterval(()=>send({t:"heartbeat"}),1000).unref();`;

export function createWorkflowBackend(options: WorkflowBackendOptions): WorkflowBackend {
    const runs = new Map<string, ActiveRun>();
    const listeners = new Set<(run: WorkflowRunSummaryV1) => void>();
    let shuttingDown = false;
    const now = options.now ?? Date.now;
    const publish = (active: ActiveRun) => {
        active.summary.updatedAt = now();
        const copy = structuredClone(active.summary);
        options.eventSink?.(copy);
        for (const listener of listeners) listener(copy);
    };
    const launch = async (input: WorkflowLaunch) => {
        if (shuttingDown) throw new Error("Workflow backend is shutting down.");
        preflightWorkflow(input.script);
        const node = await resolveWorkflowNode({ environment: options.environment, configuredPath: options.nodePath });
        const id = crypto.randomUUID(),
            timestamp = now(),
            controller = new AbortController();
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
            limits: { ...DEFAULT_WORKFLOW_LIMITS },
            recentActivity: [],
            updatedAt: timestamp,
        };
        const active: ActiveRun = { summary, script: input.script, controller, settlement: Promise.resolve() };
        runs.set(id, active);
        publish(active);
        active.settlement = execute(active, input, node);
        return { runId: id };
    };
    const execute = async (active: ActiveRun, input: WorkflowLaunch, node: string) => {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-workflow-"));
        const worker = path.join(directory, "worker.mjs");
        await fs.promises.writeFile(worker, WORKER_SOURCE, { mode: 0o600 });
        const canonical = await realpath(worker);
        let child: ReturnType<typeof spawn> | undefined;
        try {
            child = spawn(
                node,
                ["--permission", `--allow-fs-read=${canonical}`, "--max-old-space-size=128", canonical],
                { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: {} },
            );
            active.child = child;
            active.summary.status = "running";
            active.summary.startedAt = now();
            publish(active);
            if (!child.stdin || !child.stdout) throw new Error("Workflow worker pipes were not created.");
            const stdin = child.stdin,
                stdout = child.stdout;
            let buffer = "",
                pending = 0,
                agents = 0,
                phaseId: string | undefined;
            let terminal = false;
            const finish = (status: "succeeded" | "failed" | "cancelled", error?: string, result?: unknown) => {
                if (terminal) return;
                terminal = true;
                active.summary.status = status;
                active.summary.endedAt = now();
                if (error) active.summary.error = error;
                if (result !== undefined) {
                    active.result = bounded(result);
                }
                publish(active);
            };
            const send = (frame: unknown) => stdin.write(`${bounded(frame)}\n`);
            const handle = async (frame: any) => {
                if (!frame || frame.v !== 1 || typeof frame.t !== "string")
                    throw new Error("Malformed workflow worker frame.");
                if (frame.t === "ready") {
                    send({ v: 1, t: "start", script: input.script, args: input.args });
                    return;
                }
                if (frame.t === "heartbeat") return;
                if (frame.t === "terminal") {
                    frame.ok ? finish("succeeded", undefined, frame.value) : finish("failed", String(frame.error));
                    stdin.end();
                    child?.kill("SIGTERM");
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
                    let value: any = null;
                    if (frame.method === "phase") {
                        const name = String(frame.value?.name ?? "").slice(0, 512);
                        if (!name) throw new Error("Invalid phase");
                        phaseId = `phase-${active.summary.phases.length + 1}`;
                        active.summary.currentPhase = phaseId;
                        active.summary.phases.push({
                            id: phaseId,
                            name,
                            status: "running",
                            updatedAt: now(),
                            agentIds: [],
                        });
                        publish(active);
                    } else if (frame.method === "log") {
                        active.summary.recentActivity.push({
                            sequence: (active.summary.recentActivity.at(-1)?.sequence ?? 0) + 1,
                            timestamp: now(),
                            kind: "log",
                            title: String(frame.value?.message ?? "").slice(0, 2000),
                        });
                        active.summary.recentActivity = active.summary.recentActivity.slice(-20);
                        publish(active);
                    } else if (frame.method === "agent") {
                        if (++agents > DEFAULT_WORKFLOW_LIMITS.maxAgents)
                            throw new Error("Workflow agent cap exceeded.");
                        const prompt = frame.value?.prompt,
                            opts = frame.value?.options ?? {};
                        if (
                            typeof prompt !== "string" ||
                            !prompt.trim() ||
                            Buffer.byteLength(prompt) > 8000 ||
                            typeof opts !== "object"
                        )
                            throw new Error("Invalid agent request.");
                        const agentId = `agent-${agents}`,
                            retries = Math.min(3, Math.max(0, Number(opts.retries) || 0)),
                            timeoutMs = Math.min(
                                DEFAULT_WORKFLOW_LIMITS.timeoutMs,
                                Math.max(1, Number(opts.timeoutMs) || DEFAULT_WORKFLOW_LIMITS.timeoutMs),
                            );
                        const agent: any = {
                            id: agentId,
                            label: String(opts.label || prompt).slice(0, 512),
                            role: String(opts.role || "generic").slice(0, 128),
                            ...(typeof opts.model === "string" ? { model: opts.model.slice(0, 256) } : {}),
                            status: "running",
                            phaseId,
                            startedAt: now(),
                            updatedAt: now(),
                            usage: emptyUsage(),
                            prompt: prompt.slice(0, 8000),
                            recentActivity: [],
                        };
                        active.summary.agents.push(agent);
                        if (phaseId) active.summary.phases.find((p) => p.id === phaseId)?.agentIds.push(agentId);
                        publish(active);
                        let last: any;
                        for (let attempt = 0; attempt <= retries; attempt++) {
                            const timeout = AbortSignal.timeout(timeoutMs),
                                signal = AbortSignal.any([active.controller.signal, timeout]);
                            try {
                                last = await options.agentExecutor({
                                    prompt,
                                    role: agent.role,
                                    model: agent.model,
                                    schema: opts.schema,
                                    signal,
                                    timeoutMs,
                                });
                                if (!schemaValid(last.value, opts.schema))
                                    throw new Error("Agent result does not match schema.");
                                break;
                            } catch (e) {
                                if (attempt === retries) throw e;
                            }
                        }
                        value = last.value;
                        agent.status = "succeeded";
                        agent.endedAt = agent.updatedAt = now();
                        publish(active);
                    } else throw new Error(`Unknown workflow RPC method: ${frame.method}`);
                    send({ v: 1, t: "reply", id: frame.id, ok: true, value });
                } catch (error) {
                    send({ v: 1, t: "reply", id: frame.id, ok: false, error: message(error) });
                } finally {
                    pending--;
                }
            };
            stdout.setEncoding("utf8");
            stdout.on("data", (chunk) => {
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
                        void handle(JSON.parse(line)).catch((e) => {
                            finish("failed", message(e));
                            active.controller.abort();
                        });
                    } catch (e) {
                        finish("failed", "Malformed workflow worker output.");
                        active.controller.abort();
                    }
                }
            });
            await new Promise<void>((resolve) => {
                child!.once("error", (e) => {
                    finish("failed", message(e));
                    resolve();
                });
                child!.once("close", () => {
                    if (!terminal)
                        finish(
                            active.controller.signal.aborted ? "cancelled" : "failed",
                            active.controller.signal.aborted
                                ? undefined
                                : "Workflow worker exited without a terminal result.",
                        );
                    resolve();
                });
                active.controller.signal.addEventListener(
                    "abort",
                    () => {
                        try {
                            process.platform !== "win32" && child!.pid
                                ? process.kill(-child!.pid, "SIGTERM")
                                : child!.kill("SIGTERM");
                        } catch {}
                        setTimeout(() => {
                            try {
                                process.platform !== "win32" && child!.pid
                                    ? process.kill(-child!.pid, "SIGKILL")
                                    : child!.kill("SIGKILL");
                            } catch {}
                        }, 500).unref();
                    },
                    { once: true },
                );
            });
        } finally {
            active.child = undefined;
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    };
    return {
        launch,
        list: () => [...runs.values()].map((r) => structuredClone(r.summary)),
        inspect: (id) => {
            const r = runs.get(id);
            if (!r) throw new Error(`Unknown workflow run: ${id}`);
            return { run: structuredClone(r.summary), script: r.script, ...(r.result ? { result: r.result } : {}) };
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async control(id, action) {
            const run = runs.get(id);
            if (!run) throw new Error(`Unknown workflow run: ${id}`);
            if (action === "stop") run.controller.abort();
            else if (action === "pause" || action === "resume")
                throw new Error("Pause/resume scheduling is reserved for WS6.");
            else throw new Error(`${action} is reserved for WS6.`);
        },
        async shutdown() {
            if (shuttingDown) return;
            shuttingDown = true;
            for (const run of runs.values()) if (!TERMINAL.has(run.summary.status)) run.controller.abort();
            await Promise.allSettled([...runs.values()].map((run) => run.settlement));
            listeners.clear();
        },
    };
}
