import { cp, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FleetSpec, FleetState, IterationSnapshot, NodeState, Verdict } from "./types.js";

export function initFleetState(spec: FleetSpec): FleetState {
  const nodes: Record<string, NodeState> = {};
  for (const w of spec.workers) {
    nodes[w.id] = { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
  }
  return {
    fleet_name: spec.fleet_name,
    status: "planned",
    created_at: new Date().toISOString(),
    cost_usd_estimate: 0,
    nodes,
    iteration: 1,
    lgtm_streak: 0,
    paused: false,
    iterations: [],
  };
}

export async function readState(fleetRoot: string): Promise<FleetState> {
  const parsed = JSON.parse(await readFile(join(fleetRoot, "state.json"), "utf-8")) as Partial<FleetState>;
  if (!parsed.fleet_name || !parsed.status || !parsed.created_at || !parsed.nodes) {
    throw new Error("invalid state.json");
  }
  return {
    ...parsed as FleetState,
    cost_usd_estimate: parsed.cost_usd_estimate ?? 0,
    iteration: parsed.iteration ?? 1,
    lgtm_streak: parsed.lgtm_streak ?? 0,
    paused: parsed.paused ?? false,
    iterations: parsed.iterations ?? [],
    pid: parsed.pid,
    heartbeat_at: parsed.heartbeat_at,
  };
}

export function fleetCost(state: FleetState): number {
  const liveCost = Object.values(state.nodes).reduce((sum, n) => sum + n.cost_usd_estimate, 0);
  const archivedCost = state.iterations.reduce(
    (sum, iter) => sum + Object.values(iter.nodes).reduce((s, n) => s + n.cost_usd_estimate, 0),
    0,
  );
  return liveCost + archivedCost;
}

export async function writeState(fleetRoot: string, state: FleetState): Promise<void> {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = join(fleetRoot, `.state.json.${unique}.tmp`);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(tmp, join(fleetRoot, "state.json"));
}

export function snapshotIteration(
  state: FleetState,
  verdict: Verdict | null,
  verdictBody: string | null,
  spec?: FleetSpec,
): FleetState {
  const now = new Date().toISOString();
  const startedAts = spec
    ? spec.workers
        .filter((w) => w.iterate !== false)
        .map((w) => state.nodes[w.id]?.started_at)
        .filter((s): s is string => !!s)
        .sort()
    : Object.values(state.nodes)
        .map((n) => n.started_at)
        .filter((s): s is string => !!s)
        .sort();
  const snapshot: IterationSnapshot = {
    n: state.iteration,
    verdict,
    verdict_body: verdictBody,
    started_at: startedAts[0] ?? now,
    ended_at: now,
    nodes: structuredClone(state.nodes) as Record<string, NodeState>,
  };
  const zeroed: Record<string, NodeState> = {};
  for (const [id, n] of Object.entries(state.nodes)) {
    zeroed[id] = { ...n, cost_usd_estimate: 0 };
  }
  return { ...state, nodes: zeroed, iterations: [...state.iterations, snapshot] };
}

export function resetForIteration(state: FleetState, spec: FleetSpec): FleetState {
  const nodes = { ...state.nodes };
  for (const w of spec.workers) {
    if (w.iterate !== false) {
      nodes[w.id] = { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
    }
  }
  const cost = fleetCost({ ...state, nodes });
  return { ...state, iteration: state.iteration + 1, nodes, cost_usd_estimate: cost };
}

export async function archiveIteration(fleetRoot: string, n: number, nodeIds: string[]): Promise<void> {
  for (const id of nodeIds) {
    const workerDir = join(fleetRoot, "workers", id);
    const iterDir = join(fleetRoot, "iterations", String(n), "workers", id);
    await cp(join(workerDir, "output"), join(iterDir, "output"), { recursive: true });
    try {
      await cp(join(workerDir, "prompt.md"), join(iterDir, "..", `${id}-prompt.md`));
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code !== "ENOENT") throw e;
    }
  }
}

export function patchNode(
  _fleetRoot: string,
  state: FleetState,
  nodeId: string,
  patch: Partial<NodeState>,
): FleetState {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`unknown node "${nodeId}"`);
  const nodes = { ...state.nodes, [nodeId]: { ...node, ...patch } };
  const cost = fleetCost({ ...state, nodes });
  return { ...state, nodes, cost_usd_estimate: cost };
}

export function relaunchResetIds(spec: FleetSpec, state: FleetState, nodeId: string): string[] {
  if (!state.nodes[nodeId]) throw new Error(`unknown node "${nodeId}"`);
  const dependents: Record<string, string[]> = {};
  for (const w of spec.workers) {
    for (const dep of w.depends_on) {
      (dependents[dep] ??= []).push(w.id);
    }
  }
  const out = [nodeId];
  const seen = new Set(out);
  const queue = [nodeId];
  while (queue.length) {
    for (const d of dependents[queue.shift()!] ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (state.nodes[d]?.status === "blocked") out.push(d);
      queue.push(d);
    }
  }
  return out;
}

export function resetForRelaunch(state: FleetState, spec: FleetSpec, nodeId: string): FleetState {
  const fresh: NodeState = { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
  const nodes = { ...state.nodes };
  for (const id of relaunchResetIds(spec, state, nodeId)) {
    if (id !== nodeId && state.nodes[id]?.status !== "blocked") continue;
    nodes[id] = fresh;
  }

  const cost = fleetCost({ ...state, nodes });
  return { ...state, nodes, paused: false, cost_usd_estimate: cost };
}
