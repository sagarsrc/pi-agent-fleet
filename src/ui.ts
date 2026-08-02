import type { FleetSpec, FleetState, NodeStatus } from "./types.js";

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "⠹", blocked: "⊘", killed: "⊘", pending: "○", ready: "○",
};

export function buildWidgetLines(spec: FleetSpec, state: FleetState): string[] {
  const done = spec.workers.filter((w) => state.nodes[w.id].status === "completed").length;
  const loop = spec.config.loop;
  let header: string;
  if (loop) {
    const lgtmCount = loop.lgtm_count ?? 1;
    const lastVerdict = state.iterations.length > 0 ? state.iterations[state.iterations.length - 1].verdict : null;
    const streakSegment = loop.gate === "reviewer" ? ` · streak ${state.lgtm_streak}/${lgtmCount}` : "";
    header = `● fleet: ${spec.fleet_name} · iteration ${state.iteration}/${loop.max_iterations} · last verdict: ${lastVerdict ?? "—"}${streakSegment} (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`;
  } else {
    header = `● fleet: ${spec.fleet_name}  (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`;
  }
  const lines = [header];
  spec.workers.forEach((w, i) => {
    const n = state.nodes[w.id];
    const branch = i === spec.workers.length - 1 ? "└─" : "├─";
    const detail = n.status === "running" ? ` · ${n.turns} turns · ${(n.tokens / 1000).toFixed(1)}k tok` : "";
    const note = n.status_note ? ` · ${n.status_note}` : "";
    const model = w.model ?? spec.config.model ?? "(default)";
    const modelLabel = model === "(default)" ? model : `(${model})`;
    lines.push(`${branch} ${ICON[n.status]} ${w.id} ${modelLabel}${detail}${note}`);
  });
  return lines;
}
