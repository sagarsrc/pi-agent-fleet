import { createAgentSession, SessionManager, DefaultResourceLoader, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
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
  extensionAllowlist?: string[];
}

export type SessionFactory = (opts: SessionOpts) => Promise<AgentSessionLike>;

// Fleet workers must not load user extensions/skills: reading global skill files
// burns tokens mid-task, and extensions like pi-web-access run background async work
// that can crash the pi process after the session is disposed.
// Exception: some model providers are registered BY extensions (e.g. opencode-pi
// registers the opencode-cli provider). worker_extensions allowlists exactly those.
export function filterExtensionsByAllowlist<T extends { path: string }>(
  extensions: T[],
  allowlist: string[] | undefined,
): T[] {
  if (!allowlist || allowlist.length === 0) return extensions;
  return extensions.filter((e) => allowlist.some((a) => e.path.includes(a)));
}

async function createLeanResourceLoader(cwd: string, extensionAllowlist?: string[]): Promise<DefaultResourceLoader> {
  const allow = extensionAllowlist && extensionAllowlist.length > 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: !allow,
    extensionsOverride: allow
      ? (base) => ({ ...base, extensions: filterExtensionsByAllowlist(base.extensions, extensionAllowlist) })
      : undefined,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}

export const defaultSessionFactory: SessionFactory = async (opts) => {
  const resourceLoader = await createLeanResourceLoader(opts.cwd, opts.extensionAllowlist);
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    tools: opts.tools,
    sessionManager: SessionManager.create(opts.cwd, opts.sessionDir),
    thinkingLevel: opts.thinkingLevel as ThinkingLevelOption,
    resourceLoader,
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
  onSession?: (session: AgentSessionLike) => void;
  sessionFactory?: SessionFactory;
  thinkingLevel?: ThinkingLevelName;
  extensionAllowlist?: string[];
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
      extensionAllowlist: opts.extensionAllowlist,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onEvent({ type: "error", nodeId: opts.nodeId, message });
    return { ok: false, turns: 0, tokens: 0, cost: 0, error: message };
  }
  opts.onSession?.(session);
  let turns = 0;
  let tokens = 0;
  let cost = 0;
  // pi resolves session.prompt() normally even when the model run ends in an error
  // (e.g. provider usage limit) — the failure is only visible on the final assistant
  // message's stopReason/errorMessage. Track the last assistant message so a resolved
  // prompt that actually errored is reported as ok:false instead of running the output
  // contract against files that were never written.
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  const unsub = session.subscribe((e) => {
    if (e.type === "turn_end") {
      turns++;
      opts.onEvent({ type: "turn", nodeId: opts.nodeId, turns });
    }
    if (e.type === "message_end") {
      const msg = e.message as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        usage?: { totalTokens?: number; cost?: { total?: number } };
      } | undefined;
      if (msg?.role === "assistant") {
        lastStopReason = msg.stopReason;
        lastErrorMessage = msg.errorMessage;
      }
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
    if (lastStopReason === "error") {
      const message = lastErrorMessage ?? "worker model run ended with an error";
      opts.onEvent({ type: "error", nodeId: opts.nodeId, message });
      return { ok: false, turns, tokens, cost, error: message };
    }
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
    const resourceLoader = await createLeanResourceLoader(opts.cwd, opts.extensionAllowlist);
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      tools: opts.tools,
      sessionManager: SessionManager.create(opts.cwd, opts.sessionDir),
      model,
      thinkingLevel: opts.thinkingLevel as ThinkingLevelOption,
      resourceLoader,
    });
    return session as unknown as AgentSessionLike;
  };
}

export function workerWithResolvedModel(worker: WorkerSpec, model: Model<Api> | undefined): WorkerSpec {
  return model ? { ...worker, model: `${model.provider}/${model.id}` } : worker;
}
