import { createAgentSession, SessionManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevelName, WorkerSpec } from "./types.js";
import { WORKER_TYPE_TOOLS } from "./types.js";

export type ThinkingLevelOption = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export type WorkerEvent =
  | { type: "turn"; nodeId: string; turns: number }
  | { type: "tokens"; nodeId: string; tokens: number }
  | { type: "cost"; nodeId: string; cost: number }
  | { type: "done"; nodeId: string }
  | { type: "error"; nodeId: string; message: string };

export interface AgentSessionLike {
  prompt(t: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(l: (e: { type: string; message?: unknown }) => void): () => void;
  dispose(): void;
}

export interface SessionOpts {
  cwd: string;
  sessionDir: string;
  tools: string[];
  model?: string;
  thinkingLevel?: ThinkingLevelName;
}

export type SessionFactory = (opts: SessionOpts) => Promise<AgentSessionLike>;

export const defaultSessionFactory: SessionFactory = async (opts) => {
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    tools: opts.tools,
    sessionManager: SessionManager.create(opts.cwd, opts.sessionDir),
    thinkingLevel: opts.thinkingLevel as ThinkingLevelOption,
  });
  return session as unknown as AgentSessionLike;
};

export interface RunWorkerOpts {
  nodeId: string;
  worker: WorkerSpec;
  prompt: string;
  repoCwd: string;
  sessionDir?: string;
  onEvent: (e: WorkerEvent) => void;
  sessionFactory?: SessionFactory;
  thinkingLevel?: ThinkingLevelName;
}

export interface RunWorkerResult {
  ok: boolean;
  turns: number;
  tokens: number;
  cost: number;
  error?: string;
}

export async function runWorker(opts: RunWorkerOpts): Promise<RunWorkerResult> {
  const factory = opts.sessionFactory ?? defaultSessionFactory;
  let session: AgentSessionLike;
  try {
    session = await factory({
      cwd: opts.repoCwd,
      sessionDir: opts.sessionDir ?? opts.repoCwd,
      tools: WORKER_TYPE_TOOLS[opts.worker.type],
      model: opts.worker.model,
      thinkingLevel: opts.thinkingLevel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onEvent({ type: "error", nodeId: opts.nodeId, message });
    return { ok: false, turns: 0, tokens: 0, cost: 0, error: message };
  }
  let turns = 0;
  let tokens = 0;
  let cost = 0;
  const unsub = session.subscribe((e) => {
    if (e.type === "turn_end") {
      turns++;
      opts.onEvent({ type: "turn", nodeId: opts.nodeId, turns });
    }
    if (e.type === "message_end") {
      const msg = e.message as { role?: string; usage?: { totalTokens?: number; cost?: { total?: number } } } | undefined;
      if (msg?.role === "assistant" && msg.usage?.totalTokens) {
        tokens += msg.usage.totalTokens;
        opts.onEvent({ type: "tokens", nodeId: opts.nodeId, tokens });
      }
      if (msg?.role === "assistant" && msg.usage?.cost?.total) {
        cost += msg.usage.cost.total;
        opts.onEvent({ type: "cost", nodeId: opts.nodeId, cost });
      }
    }
  });
  try {
    await session.prompt(opts.prompt);
    opts.onEvent({ type: "done", nodeId: opts.nodeId });
    return { ok: true, turns, tokens, cost };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onEvent({ type: "error", nodeId: opts.nodeId, message });
    return { ok: false, turns, tokens, cost, error: message };
  } finally {
    unsub();
    session.dispose();
  }
}

export function sessionFactoryForModel(model: Model<Api>): SessionFactory {
  return async (opts) => {
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      tools: opts.tools,
      sessionManager: SessionManager.create(opts.cwd, opts.sessionDir),
      model,
      thinkingLevel: opts.thinkingLevel as ThinkingLevelOption,
    });
    return session as unknown as AgentSessionLike;
  };
}

export function workerWithResolvedModel(worker: WorkerSpec, model: Model<Api> | undefined): WorkerSpec {
  return model ? { ...worker, model: `${model.provider}/${model.id}` } : worker;
}
