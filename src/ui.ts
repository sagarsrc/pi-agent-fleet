import type { FleetSpec, FleetState, NodeStatus } from "./types.js";

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "⠹", blocked: "⊘", killed: "⊘", pending: "○", ready: "○",
};

export function buildWidgetLines(spec: FleetSpec, state: FleetState): string[] {
  const done = spec.workers.filter((w) => state.nodes[w.id].status === "completed").length;
  const lines = [`● fleet: ${spec.fleet_name}  (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`];
  spec.workers.forEach((w, i) => {
    const n = state.nodes[w.id];
    const branch = i === spec.workers.length - 1 ? "└─" : "├─";
    const detail = n.status === "running" ? ` · ${n.turns} turns · ${(n.tokens / 1000).toFixed(1)}k tok` : "";
    const note = n.status_note ? ` · ${n.status_note}` : "";
    lines.push(`${branch} ${ICON[n.status]} ${w.id}${detail}${note}`);
  });
  return lines;
}
