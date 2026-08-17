import { basename } from "node:path";
import { getDependents } from "./dag.js";
import type { FleetSpec, FleetState } from "./types.js";
import { renderDag } from "./viz.js";

export function buildWorkerPrompt(opts: {
  spec: FleetSpec;
  state: FleetState;
  workerId: string;
  fleetRoot: string;
}): string {
  const { spec, state, workerId, fleetRoot } = opts;
  const worker = spec.workers.find((w) => w.id === workerId);
  if (!worker) throw new Error(`unknown worker "${workerId}"`);
  const workerDir = `${fleetRoot}/workers/${workerId}`;
  const deps = spec.workers.filter((w) => worker.depends_on.includes(w.id));
  const dependents = getDependents(spec, workerId);
  const out: string[] = [];

  out.push(
    "## Autonomy contract (read first)",
    "",
    "You are an unattended fleet worker — there is no human watching this session and nobody will answer questions.",
    "- Everything in this prompt is PRE-APPROVED. Do not ask for approval; do the work.",
    "- Do NOT invoke any skill or workflow with a human approval gate (e.g. brainstorming hard-gates). Skip gated steps and execute the task directly.",
    "- Do not end your turn with a question, a plan awaiting approval, or an 'Approve?' prompt. End your turn only when every REQUIRED output below exists on disk.",
    "- Ambiguity is yours to resolve: decide, record the decision in your output, and continue.",
    "",
  );

  const fleetTs = basename(fleetRoot);

  out.push(`# Fleet worker: ${workerId}`, "", `Type: ${worker.type}`, "", `## Task`, "", worker.task, "");

  if (state.iteration > 1 && worker.iterate !== false) {
    const last = state.iterations[state.iterations.length - 1];
    if (last?.verdict_body) {
      out.push(`## Reviewer feedback (iteration ${state.iteration - 1})`, "", last.verdict_body, "");
    }
  }

  if (worker.outputs.some((o) => o.kind === "verdict") && state.iterations.length > 0) {
    const reviews = state.iterations.filter((s) => s.verdict !== null);
    if (reviews.length > 0) {
      out.push("## Previous reviews", "");
      for (const s of reviews) {
        out.push(`### Iteration ${s.n} — verdict: ${s.verdict}`);
        if (s.verdict_body) out.push(s.verdict_body);
        out.push("");
      }
    }
  }

  out.push("## The fleet DAG", "", "```", renderDag(spec), "```", "");
  for (const w of spec.workers) {
    if (w.id !== workerId) out.push(`- ${w.id} (${w.type}): ${w.task}`);
  }
  out.push("");

  out.push("## Your upstream inputs", "");
  if (deps.length === 0) {
    out.push("No upstream dependencies — you are a layer-0 node.", "");
  } else {
    for (const d of deps) {
      if (d.worktree === true) {
        out.push(`- ${d.id} worktree: ${fleetRoot}/worktrees/${d.id} (branch fleet/${fleetTs}/${d.id})`);
        out.push("  — merge or cherry-pick from here if you need its repo changes");
      }
      if (d.outputs.length === 0) out.push(`- ${d.id}: (no declared outputs — read its session notes in ${fleetRoot}/workers/${d.id}/output/ if present)`);
      for (const o of d.outputs) {
        const abs = o.path.startsWith("output/")
          ? `${fleetRoot}/workers/${d.id}/${o.path}`
          : o.path;
        out.push(`- ${d.id}: ${abs} (${o.kind})`);
      }
    }
    out.push("");
  }

  out.push("## What downstream nodes need from you", "");
  if (dependents.length === 0) {
    out.push("No downstream nodes — your outputs terminate the DAG.", "");
  } else {
    for (const dep of dependents) out.push(`- ${dep} depends on your outputs`);
    out.push("");
  }

  if (worker.outputs.some((o) => o.kind === "verdict")) {
    out.push(
      "## Writing your verdict",
      "",
      "Your review file MUST start with a verdict line, exactly one of:",
      "verdict: lgtm",
      "verdict: iterate",
      "verdict: escalate",
      "Below the verdict line, write actionable fix instructions per worker — file path, function name, what to change. A verdict line with no body FAILS the contract. The builders see this body as feedback next iteration, so be specific.",
      "",
    );
  }

  out.push("## Requesting additional nodes (optional)", "");
  out.push(`If you discover work this DAG cannot do as currently shaped, write ${workerDir}/output/node-requests.json:`, "");
  out.push(
    `{ "workers": [{ "id": "kebab-case", "type": "research|code-run|reviewer|write|read-only", "task": "self-contained instructions", "depends_on": ["${workerId}"], "outputs": [{ "path": "output/file.md", "kind": "markdown", "required": true }] }] }`,
    "",
  );
  out.push("The runner validates the merged graph (unique ids, known deps, acyclic, loop-gate rules) and inserts valid nodes as pending. Invalid batches are rejected atomically and noted on your node. Do not set model or effort fields — the runner assigns them. Depend on your own id when the new node needs your outputs.", "");
  out.push("## Your output obligations", "");
  if (worker.outputs.length === 0) {
    out.push("No declared outputs — completion is enough.", "");
  } else {
    for (const o of worker.outputs) {
      out.push(`- ${o.path} (${o.kind}${o.required ? ", REQUIRED" : ", optional"})`);
      if (o.kind === "json" && o.schema) {
        const bits: string[] = [];
        if (o.schema.required_keys && o.schema.required_keys.length > 0) {
          bits.push(`must be a JSON object containing keys: ${o.schema.required_keys.join(", ")}`);
        }
        if (o.schema.number_keys && o.schema.number_keys.length > 0) {
          bits.push(`these keys must be numbers or arrays of numbers: ${o.schema.number_keys.join(", ")}`);
        }
        if (bits.length > 0) out.push(`  - ${bits.join("; ")}`);
      }
    }
    out.push("");
  }
  if (worker.outputs.some((o) => o.path.startsWith("output/"))) {
    out.push(`Save ALL output files to ${workerDir}/output/ — use absolute paths.`, "");
  }
  if (worker.outputs.some((o) => !o.path.startsWith("output/"))) {
    out.push("Write code changes directly at their repo paths.", "");
  }
  if (worker.worktree === true) {
    out.push("## Your worktree", "");
    out.push("Work inside your own git worktree, not the main checkout.");
    out.push("If it does not exist yet, create it:");
    out.push(`  git worktree add ${fleetRoot}/worktrees/${workerId} -b fleet/${fleetTs}/${workerId}`);
    out.push("If it already exists (iteration > 1), reuse it and your existing branch.");
    out.push("Make ALL repo changes inside the worktree. Commit your work there.");
    out.push("");
  }

  return out.join("\n");
}
