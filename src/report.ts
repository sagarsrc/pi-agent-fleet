import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FleetSpec, FleetState } from "./types.js";
import { renderDag } from "./viz.js";

const execFileP = promisify(execFile);

export async function gitDiffStat(repoCwd: string, _sinceIso: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoCwd, "diff", "--stat", "HEAD"]);
    const out = stdout.trim();
    return out.length > 0 ? out : "(no changes)";
  } catch {
    return "(not a git repo)";
  }
}

export async function writeReport(opts: {
  spec: FleetSpec;
  state: FleetState;
  fleetRoot: string;
  repoCwd: string;
}): Promise<string> {
  const { spec, state, fleetRoot, repoCwd } = opts;
  const experiment = (spec as unknown as { experiment?: string }).experiment;
  const lines: string[] = [];
  lines.push(`# Fleet report: ${spec.fleet_name}`, "");
  lines.push(`- status: **${state.status}**`);
  lines.push(`- created: ${state.created_at}`);
  lines.push(`- total cost estimate: $${state.cost_usd_estimate.toFixed(2)}`);
  if (experiment) lines.push(`- experiment: ${experiment}`);
  lines.push("", "## DAG", "", "```", renderDag(spec, state), "```", "");
  lines.push("## Nodes", "", "| id | status | turns | tokens | cost | contract | outputs |",
    "|---|---|---|---|---|---|---|");
  for (const w of spec.workers) {
    const n = state.nodes[w.id];
    const contract = n.contract_result
      ? n.contract_result.ok ? "✓" : `✗ ${n.contract_result.checks.filter((c) => !c.ok).map((c) => c.path).join(", ")}`
      : "—";
    lines.push(`| ${w.id} | ${n.status} | ${n.turns} | ${n.tokens} | $${n.cost_usd_estimate.toFixed(2)} | ${contract} | ${n.produced_outputs.join(", ") || "—"} |`);
  }
  lines.push("", "## Code changes", "", "```", await gitDiffStat(repoCwd, state.created_at), "```", "");
  lines.push("## Artifacts", "", `- state: ${join(fleetRoot, "state.json")}`,
    `- sessions: ${join(fleetRoot, "workers", "<id>", "session.jsonl")}`, "");
  const md = lines.join("\n");
  await writeFile(join(fleetRoot, "report.md"), md, "utf-8");
  return md;
}
