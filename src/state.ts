import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FleetSpec, FleetState, NodeState } from "./types.js";

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
  };
}

export async function readState(fleetRoot: string): Promise<FleetState> {
  return JSON.parse(await readFile(join(fleetRoot, "state.json"), "utf-8")) as FleetState;
}

export async function writeState(fleetRoot: string, state: FleetState): Promise<void> {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = join(fleetRoot, `.state.json.${unique}.tmp`);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(tmp, join(fleetRoot, "state.json"));
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
  const cost = Object.values(nodes).reduce((sum, n) => sum + n.cost_usd_estimate, 0);
  return { ...state, nodes, cost_usd_estimate: cost };
}
