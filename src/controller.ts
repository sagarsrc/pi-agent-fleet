import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { persistFleetJson, writeWorkerPrompts } from "./fleet-store.js";
import { recoverLatestFleet } from "./fleet-recovery.js";
import { resolveModelReference, type ModelRegistryLike } from "./model-resolution.js";
import { insertWorkers } from "./insert.js";
import { writeReport } from "./report.js";
import { runWorker, sessionFactoryForModel, workerWithResolvedModel, type AgentSessionLike } from "./runner.js";
import { runFleet } from "./scheduler.js";
import { patchNode, readState, resetForRelaunch, writeState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";
import { TERMINAL_NODE_STATUSES } from "./types.js";
import { buildWidgetLines } from "./ui.js";
import { dagNeedsFileFallback, renderDag } from "./viz.js";
import { startCanvasServer, type CanvasServer } from "./canvas.js";

export interface ActiveFleet {
  spec: FleetSpec;
  fleetRoot: string;
  state: FleetState;
  killSwitch: { killed: boolean };
  pauseSwitch: { paused: boolean };
  running: boolean;
  costWarned?: boolean;
  sessions: Map<string, AgentSessionLike>;
  killedNodes: Set<string>;
  relaunchRequests: Set<string>;
  widgetVisible?: boolean;
}

export interface ActiveFleetCell {
  current: ActiveFleet | undefined;
}

export const activeFleet: ActiveFleetCell = { current: undefined };

export function updateWidget(ctx: ExtensionContext, fleet: ActiveFleet, spinnerFrame?: number): void {
  if (ctx.hasUI && fleet.widgetVisible) ctx.ui.setWidget("fleet", buildWidgetLines(fleet.spec, fleet.state, { spinnerFrame }));
}

export function startSpinner(ctx: ExtensionContext, fleet: ActiveFleet, intervalMs = 150): () => void {
  if (!ctx.hasUI) return () => {};
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    updateWidget(ctx, fleet, frame);
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export async function currentState(fleet: ActiveFleet): Promise<FleetState> {
  if (fleet.running) return fleet.state;
  try {
    fleet.state = await readState(fleet.fleetRoot);
  } catch {
    // keep in-memory state
  }
  return fleet.state;
}

export async function statusText(fleet: ActiveFleet): Promise<string> {
  const state = await currentState(fleet);
  const reportPath = join(fleet.fleetRoot, "report.md");
  const failed = Object.entries(state.nodes).find(([, n]) => n.status === "failed" || n.status === "contract_failed");
  const next = state.status === "planned" ? "next: fleet_launch"
    : state.status === "running" ? "next: fleet_status, fleet_canvas, or fleet_kill <id>|all"
    : failed ? `next: fleet_relaunch ${failed[0]}`
    : state.status === "completed" ? `next: read report ${reportPath}`
    : `next: inspect ${join(fleet.fleetRoot, "state.json")}`;
  let crashWarning = "";
  if (state.status === "running") {
    const heartbeat = state.heartbeat_at;
    const stale = !heartbeat || (Date.now() - new Date(heartbeat).getTime() > 60000);
    if (stale && typeof state.pid === "number") {
      let dead = false;
      try {
        process.kill(state.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") dead = true;
      }
      if (dead) {
        crashWarning = `\n\nwarning: fleet appears crashed (stale heartbeat/dead pid ${state.pid}); run fleet_continue to recover`;
      }
    }
  }
  return `${renderDag(fleet.spec, state)}\n\nreport: ${reportPath}\n${next}${crashWarning}`;
}

export function checkCostLimits(fleet: ActiveFleet, ctx: ExtensionContext): void {
  const warn = fleet.spec.config.warn_cost_usd;
  const cap = fleet.spec.config.max_cost_usd;
  const cost = fleet.state.cost_usd_estimate;
  if (warn && !fleet.costWarned && cost >= warn) {
    fleet.costWarned = true;
    if (ctx.hasUI) ctx.ui.notify(`fleet cost warning: $${cost.toFixed(4)} >= $${warn}`, "warning");
  }
  if (cap && cost >= cap && !fleet.killSwitch.killed) {
    fleet.killSwitch.killed = true;
    if (ctx.hasUI) ctx.ui.notify(`fleet cost cap reached: $${cost.toFixed(4)} >= $${cap.toFixed(4)}`, "error");
  }
}

export async function dagPreview(spec: FleetSpec, state: FleetState | undefined, fleetRoot: string): Promise<string> {
  const out = renderDag(spec, state);
  const width = process.stdout.columns ?? 120;
  if (dagNeedsFileFallback(spec, width)) {
    const p = join(fleetRoot, "dag.txt");
    await writeFile(p, out, "utf-8");
    return `${out}\n\nDAG preview saved: ${p}`;
  }
  return out;
}

export function prepareRelaunch(fleet: ActiveFleet, nodeId: string): void {
  fleet.killedNodes.delete(nodeId);
  fleet.killSwitch.killed = false;
  fleet.pauseSwitch.paused = false;
}

export interface RelaunchRequestResult {
  message: string;
  startNow: boolean;
}

export async function requestRelaunch(
  fleet: ActiveFleet,
  nodeId: string,
  model: string | undefined,
  registry: ModelRegistryLike,
): Promise<RelaunchRequestResult> {
  const worker = fleet.spec.workers.find((w) => w.id === nodeId);
  if (!worker) return { message: `unknown node "${nodeId}"`, startNow: false };
  const node = fleet.state.nodes[nodeId];
  const relaunchable: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed"]);
  if (!node || !relaunchable.has(node.status)) {
    return {
      message: `node "${nodeId}" status ${node?.status ?? "missing"} cannot be relaunched; must be failed, contract_failed, or killed`,
      startNow: false,
    };
  }
  if (model) {
    const resolved = resolveModelReference(registry, model);
    if (!resolved.ok) return { message: resolved.error, startNow: false };
    const canonical = `${resolved.model.provider}/${resolved.model.id}`;
    fleet.spec.workers = fleet.spec.workers.map((w) => (w.id === nodeId ? { ...w, model: canonical } : w));
    await persistFleetJson(fleet);
  }
  prepareRelaunch(fleet, nodeId);
  if (fleet.running) {
    fleet.relaunchRequests.add(nodeId);
    return {
      message: `relaunch queued for ${nodeId} (fleet running; dispatches on next scheduler pass)`,
      startNow: false,
    };
  }
  fleet.state = resetForRelaunch(fleet.state, fleet.spec, nodeId);
  await writeState(fleet.fleetRoot, fleet.state);
  await writeWorkerPrompts(fleet);
  return { message: `fleet relaunch requested for ${nodeId}`, startNow: true };
}

export function registerNodeSession(fleet: ActiveFleet, nodeId: string, session: AgentSessionLike): void {
  fleet.sessions.set(nodeId, session);
  if (fleet.killedNodes.has(nodeId)) void session.abort().catch(() => {});
}

export async function drainNodeRequests(
  fleet: ActiveFleet,
  nodeId: string,
  registry: ModelRegistryLike,
): Promise<string | undefined> {
  const p = join(fleet.fleetRoot, "workers", nodeId, "output", "node-requests.json");
  let raw: string;
  try {
    raw = await readFile(p, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `node-requests.json invalid JSON: ${(e as Error).message}`;
  }
  const r = await insertWorkers(fleet, parsed, registry);
  if (!r.ok) {
    const detail = r.message.replace("invalid node insertion:\n", "").split("\n")[0];
    return `node-requests rejected: ${detail}`;
  }
  return undefined;
}

export async function startLoop(fleet: ActiveFleet, ctx: ExtensionContext, resume = false, continuePass = false): Promise<void> {
  let resumeFrom: FleetState | undefined;
  try {
    if (continuePass) {
      resumeFrom = fleet.state;
    } else if (resume) {
      resumeFrom = await readState(fleet.fleetRoot);
    }
  } catch (err: unknown) {
    fleet.running = false;
    const error = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`fleet failed: ${error}`, "error");
    return;
  }

  fleet.running = true;
  fleet.costWarned = false;
  fleet.state = { ...fleet.state, status: "running", pid: process.pid, heartbeat_at: new Date().toISOString() };
  await writeState(fleet.fleetRoot, fleet.state);
  const stopSpinner = startSpinner(ctx, fleet);
  updateWidget(ctx, fleet);

  let lastHeartbeatWrite = Date.now();
  const heartbeatInterval = setInterval(async () => {
    const now = Date.now();
    if (now - lastHeartbeatWrite < 5000) return;
    fleet.state = { ...fleet.state, heartbeat_at: new Date().toISOString() };
    lastHeartbeatWrite = now;
    try {
      await writeState(fleet.fleetRoot, fleet.state);
    } catch {
      // ignore heartbeat write failures
    }
  }, 5000);
  if (typeof heartbeatInterval.unref === "function") heartbeatInterval.unref();

  let cleanedUp = false;
  let finalStateWritten = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopSpinner();
    clearInterval(heartbeatInterval);
  };
  const writeFinalState = async () => {
    if (finalStateWritten) return;
    finalStateWritten = true;
    try {
      await writeState(fleet.fleetRoot, fleet.state);
    } catch {
      // best-effort final persistence
    }
  };

  const spawn = async (nodeId: string) => {
    try {
      const worker = fleet.spec.workers.find((w) => w.id === nodeId);
      if (!worker) return { ok: false, turns: 0, tokens: 0, error: `unknown worker "${nodeId}"` };

      let resolvedModel: Model<Api> | undefined;
      let modelNote: string | undefined;
      if (worker.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, worker.model);
        if (!resolved.ok) return { ok: false, turns: 0, tokens: 0, error: resolved.error };
        resolvedModel = resolved.model;
      } else if (fleet.spec.config.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, fleet.spec.config.model);
        if (resolved.ok) resolvedModel = resolved.model;
        else modelNote = `config.model "${fleet.spec.config.model}" not found, using session default`;
      }
      if (modelNote) {
        fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: modelNote });
        updateWidget(ctx, fleet);
      }

      const prompt = await readFile(join(fleet.fleetRoot, "workers", nodeId, "prompt.md"), "utf-8");
      const sessionDir = join(fleet.fleetRoot, "workers", nodeId);
      const effort = worker.effort ?? fleet.spec.config.effort ?? "medium";
      const worktreeCwd = worker?.worktree || worker?.id === "fleet-integrator"
        ? join(fleet.fleetRoot, "worktrees", nodeId)
        : ctx.cwd;
      try {
        return await runWorker({
          nodeId,
          worker: workerWithResolvedModel(worker, resolvedModel),
          prompt,
          repoCwd: worktreeCwd,
          sessionDir,
          thinkingLevel: effort,
          extensionAllowlist: fleet.spec.config.worker_extensions,
          sessionFactory: resolvedModel ? sessionFactoryForModel(resolvedModel) : undefined,
          onSession: (s) => registerNodeSession(fleet, nodeId, s),
          onEvent: (e) => {
            if (e.type === "turn") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { turns: e.turns });
            if (e.type === "tokens") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { tokens: e.tokens });
            if (e.type === "cost") {
              fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { cost_usd_estimate: e.cost });
              checkCostLimits(fleet, ctx);
            }
            if (e.type === "error") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: e.message });
            updateWidget(ctx, fleet);
          },
        });
      } finally {
        fleet.sessions.delete(nodeId);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, turns: 0, tokens: 0, error };
    }
  };

  try {
    const state = await runFleet({
      spec: fleet.spec,
      fleetRoot: fleet.fleetRoot,
      baseRepo: ctx.cwd,
      repoCwd: (nodeId) => {
        const worker = fleet.spec.workers.find((w) => w.id === nodeId);
        return worker?.worktree || worker?.id === "fleet-integrator"
          ? join(fleet.fleetRoot, "worktrees", nodeId)
          : ctx.cwd;
      },
      spawn,
      killSwitch: fleet.killSwitch,
      pauseSwitch: fleet.pauseSwitch,
      nodeKills: fleet.killedNodes,
      relaunchRequests: fleet.relaunchRequests,
      onNodeChange: (nodeId, nodeState) => {
        fleet.state = fleet.state.nodes[nodeId]
          ? patchNode(fleet.fleetRoot, fleet.state, nodeId, nodeState)
          : { ...fleet.state, nodes: { ...fleet.state.nodes, [nodeId]: nodeState } };
        checkCostLimits(fleet, ctx);
        updateWidget(ctx, fleet);
      },
      onNodeAdded: (w) => {
        fleet.state = {
          ...fleet.state,
          nodes: {
            ...fleet.state.nodes,
            [w.id]: { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
          },
        };
        updateWidget(ctx, fleet);
      },
      onNodeCompleted: async (nodeId) => {
        const note = await drainNodeRequests(fleet, nodeId, ctx.modelRegistry);
        if (!note) updateWidget(ctx, fleet);
        return note;
      },
      prepareIteration: async (_n, state) => {
        fleet.state = state;
        await writeWorkerPrompts(fleet);
      },
      resumeFrom,
      continuePass,
    });
    fleet.state = state;
    fleet.running = false;
    cleanup();
    updateWidget(ctx, fleet); // keep final per-node stats visible (todo #12)
    await writeReport({ spec: fleet.spec, state, fleetRoot: fleet.fleetRoot, repoCwd: ctx.cwd });
    await writeFinalState();
    const last = state.iterations[state.iterations.length - 1];
    if (state.status === "paused" && last?.verdict === "escalate") {
      if (ctx.hasUI) ctx.ui.notify(`fleet paused: reviewer escalated; report: ${join(fleet.fleetRoot, "report.md")}`, "warning");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`fleet ${state.status}; report: ${join(fleet.fleetRoot, "report.md")}`, state.status === "completed" ? "info" : "warning");
    }
  } catch (err: unknown) {
    fleet.running = false;
    cleanup();
    updateWidget(ctx, fleet);
    await writeFinalState();
    const error = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`fleet failed: ${error}`, "error");
  }
}

export async function killFleet(target: string, cwd?: string): Promise<string> {
  const active = activeFleet.current ?? (cwd ? await recoverLatestFleet(cwd) : undefined);
  if (active) activeFleet.current ??= active;
  if (!active) return "no fleet planned yet";
  if (!active.running) {
    try {
      active.state = await readState(active.fleetRoot);
    } catch {
      // keep in-memory state
    }
    if (active.state.status === "running") {
      const where = target === "all" ? "fleet" : `node "${target}"`;
      return `${where} not killed: fleet state on disk is "running" — it appears to be running in another live session; kill it there (this session holds no live scheduler, so a kill here would silently no-op)`;
    }
  }
  if (target === "all") {
    active.killSwitch.killed = true;
    return "fleet kill requested";
  }
  const worker = active.spec.workers.find((w) => w.id === target);
  const node = active.state.nodes[target];
  if (!worker || !node) return `unknown node "${target}"`;
  if (TERMINAL_NODE_STATUSES.has(node.status) && node.status !== "blocked") return `node "${target}" already ${node.status}`;
  active.killedNodes.add(target);
  const session = active.sessions.get(target);
  if (session) {
    void session.abort().catch(() => {});
    return `node "${target}" kill requested`;
  }
  if (!active.running) {
    active.state = patchNode(active.fleetRoot, active.state, target, { status: "killed", ended_at: new Date().toISOString() });
    await writeState(active.fleetRoot, active.state);
    return `node "${target}" killed`;
  }
  return `node "${target}" kill requested`;
}

let canvas: Promise<CanvasServer> | undefined;

export async function ensureCanvas(ctx: ExtensionContext): Promise<CanvasServer> {
  canvas ??= startCanvasServer({ getFleet: () => activeFleet.current, cwd: ctx.cwd });
  return canvas;
}

export async function stopCanvas(): Promise<void> {
  const current = canvas;
  canvas = undefined;
  if (current) (await current).close();
}
