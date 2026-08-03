import type { FleetSpec, FleetState, NodeState, NodeStatus, WorkerSpec } from "./types.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const DEFAULT_MAX_LINES = 12;

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "⠹", blocked: "⊘", killed: "⊘", pending: "○", ready: "○",
};

const DETAIL_STATUSES: ReadonlySet<NodeStatus> = new Set(["running", "completed", "failed", "contract_failed"]);
const ATTENTION_STATUSES: ReadonlySet<NodeStatus> = new Set(["running", "failed", "contract_failed", "killed", "blocked"]);

export interface WidgetOpts {
  maxLines?: number;
  spinnerFrame?: number;
}

export function buildWidgetLines(spec: FleetSpec, state: FleetState, opts: WidgetOpts = {}): string[] {
  const maxLines = Math.max(opts.maxLines ?? DEFAULT_MAX_LINES, 3);
  const done = spec.workers.filter((w) => state.nodes[w.id]?.status === "completed").length;
  const loop = spec.config.loop;
  let header: string;
  if (loop) {
    const lgtmCount = loop.lgtm_count ?? 1;
    const lastVerdict = state.iterations.length > 0 ? state.iterations[state.iterations.length - 1].verdict : null;
    const streakSegment = loop.gate === "reviewer" ? ` · lgtm streak ${state.lgtm_streak}/${lgtmCount}` : "";
    header = `● fleet: ${spec.fleet_name} · iteration ${state.iteration}/${loop.max_iterations} · last verdict: ${lastVerdict ?? "—"}${streakSegment} (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`;
  } else {
    header = `● fleet: ${spec.fleet_name}  (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`;
  }

  const icon = (s: NodeStatus): string =>
    s === "running" && opts.spinnerFrame !== undefined
      ? SPINNER_FRAMES[opts.spinnerFrame % SPINNER_FRAMES.length]
      : ICON[s];

  const line = (w: WorkerSpec, branch: string): string => {
    const n: NodeState = state.nodes[w.id] ?? { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
    // loop snapshots zero live per-node cost (archived into iteration totals) — fall back to the last snapshot so completed nodes keep their cost visible
    const lastIter = state.iterations.length > 0 ? state.iterations[state.iterations.length - 1] : undefined;
    const cost = n.cost_usd_estimate > 0 || n.status === "running"
      ? n.cost_usd_estimate
      : (lastIter?.nodes[w.id]?.cost_usd_estimate ?? n.cost_usd_estimate);
    const detail = DETAIL_STATUSES.has(n.status)
      ? ` · ${n.turns} turns · ${(n.tokens / 1000).toFixed(1)}k tok · $${cost.toFixed(2)}`
      : "";
    const note = n.status_note ? ` · ${n.status_note}` : "";
    const model = w.model ?? spec.config.model ?? "(default)";
    return `${branch} ${icon(n.status)} ${w.id} (${model})${detail}${note}`;
  };

  const budget = Math.max(maxLines - 1, 1);
  if (spec.workers.length <= budget) {
    const lines = [header];
    spec.workers.forEach((w, i) => {
      lines.push(line(w, i === spec.workers.length - 1 ? "└─" : "├─"));
    });
    return lines;
  }

  const attention = spec.workers.filter((w) => ATTENTION_STATUSES.has(state.nodes[w.id]?.status ?? "pending"));
  const rest = spec.workers.filter((w) => !ATTENTION_STATUSES.has(state.nodes[w.id]?.status ?? "pending"));
  const visible = [...attention, ...rest].slice(0, Math.max(budget - 1, 1));
  const hidden = spec.workers.length - visible.length;
  const lines = [header, ...visible.map((w) => line(w, "├─"))];
  lines.push(`└─ … +${hidden} more (${done}/${spec.workers.length} done)`);
  return lines;
}
