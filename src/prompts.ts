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

  out.push(`# Fleet worker: ${workerId}`, "", `Type: ${worker.type}`, "", `## Task`, "", worker.task, "");

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

  out.push("## Your output obligations", "");
  if (worker.outputs.length === 0) {
    out.push("No declared outputs — completion is enough.", "");
  } else {
    for (const o of worker.outputs) {
      out.push(`- ${o.path} (${o.kind}${o.required ? ", REQUIRED" : ", optional"})`);
    }
    out.push("");
  }
  if (worker.outputs.some((o) => o.path.startsWith("output/"))) {
    out.push(`Save ALL output files to ${workerDir}/output/ — use absolute paths.`, "");
  }
  if (worker.outputs.some((o) => !o.path.startsWith("output/"))) {
    out.push("Write code changes directly at their repo paths.", "");
  }
  return out.join("\n");
}
