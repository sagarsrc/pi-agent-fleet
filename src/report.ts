import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { FleetSpec, FleetState } from "./types.js";
import { renderDag } from "./viz.js";

const execFileP = promisify(execFile);

function formatDuration(ms: number): string {
  if (ms <= 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

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
  if (spec.config.loop) {
    lines.push("", "## Iterations", "", "| n | verdict | tokens | cost | duration |",
      "|---|---|---|---|---|");
    for (const it of state.iterations) {
      const tokens = Object.values(it.nodes).reduce((sum, n) => sum + n.tokens, 0);
      const cost = Object.values(it.nodes).reduce((sum, n) => sum + n.cost_usd_estimate, 0);
      const durationMs = new Date(it.ended_at).getTime() - new Date(it.started_at).getTime();
      lines.push(`| ${it.n} | ${it.verdict ?? "—"} | ${tokens} | $${cost.toFixed(2)} | ${formatDuration(durationMs)} |`);
    }
    for (const it of state.iterations) {
      lines.push("", `### Iteration ${it.n}`, "");
      lines.push(`- verdict: ${it.verdict ?? "—"}`);
      if (it.verdict_body) lines.push("", it.verdict_body);
      for (const w of spec.workers) {
        const n = it.nodes[w.id];
        if (n) lines.push(`- ${w.id}: ${n.status} · ${n.turns} turns · ${n.tokens} tok`);
      }
    }
  }
  if (spec.workers.some((w) => w.worktree)) {
    lines.push("", "## Worktree branches", "");
    const base = basename(fleetRoot);
    for (const w of spec.workers) {
      if (w.worktree) lines.push(`- fleet/${base}/${w.id}`);
    }
  }
  lines.push("", "## Next steps", "");
  const reportPath = join(fleetRoot, "report.md");
  const failed = Object.entries(state.nodes).find(([, n]) => n.status === "failed" || n.status === "contract_failed");
  const next = state.status === "planned" ? "fleet_launch"
    : state.status === "running" ? "fleet_status, fleet_canvas, or fleet_kill <id>|all"
    : failed ? `fleet_relaunch ${failed[0]}`
    : state.status === "completed" ? `read report ${reportPath}`
    : `inspect ${join(fleetRoot, "state.json")}`;
  lines.push(`- next: ${next}`);
  lines.push("", "## JSON outputs", "");
  let anyJson = false;
  for (const w of spec.workers) {
    const n = state.nodes[w.id];
    for (const out of n?.produced_outputs ?? []) {
      if (!out.startsWith("output/") || !out.endsWith(".json") || out.includes("..")) continue;
      anyJson = true;
      let content: string;
      try {
        const raw = await readFile(join(fleetRoot, "workers", w.id, out), "utf-8");
        content = raw.length > 4096 ? `${raw.slice(0, 4096)}\n... (truncated)` : raw;
      } catch {
        content = "(unreadable)";
      }
      lines.push(`### ${w.id}: ${out}`, "", "```json", content.trimEnd(), "```", "");
    }
  }
  if (!anyJson) lines.push("(none)", "");
  lines.push("", "## Code changes", "", "```", await gitDiffStat(repoCwd, state.created_at), "```", "");
  lines.push("## Artifacts", "", `- state: ${join(fleetRoot, "state.json")}`,
    `- sessions: ${join(fleetRoot, "workers", "<id>", "session.jsonl")}`, "");
  const md = lines.join("\n");
  await writeFile(join(fleetRoot, "report.md"), md, "utf-8");
  return md;
}
