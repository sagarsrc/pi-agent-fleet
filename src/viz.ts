import { topoLayers } from "./dag.js";
import type { FleetSpec, FleetState, NodeStatus } from "./types.js";

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "◌", blocked: "⊘", killed: "⊘",
  pending: "○", ready: "○",
};

export function renderDag(spec: FleetSpec, state?: FleetState): string {
  const layers = topoLayers(spec);
  const label = (id: string): string => {
    const st = state?.nodes[id]?.status;
    return st ? `${ICON[st]} ${id}` : id;
  };
  const lines: string[] = [];
  const header = layers.map((l, i) => `layer ${i}: ${l.map(label).join("  ")}`).join("\n");
  lines.push(header, "", "edges:");
  for (const w of spec.workers) {
    for (const d of w.depends_on) lines.push(`  ${d} --▶ ${w.id}`);
  }
  if (spec.workers.every((w) => w.depends_on.length === 0)) lines.push("  (none — all parallel)");
  return lines.join("\n");
}

export function dagNeedsFileFallback(spec: FleetSpec, termWidth: number): boolean {
  if (spec.workers.length > 15) return true;
  const layers = topoLayers(spec);
  const widest = Math.max(...layers.map((l) => l.join("  ").length + 9));
  return widest > termWidth;
}
