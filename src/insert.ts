import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveFleet } from "./controller.js";
import { validateFleetSpec } from "./dag.js";
import { resolveModelReference, type ModelRegistryLike } from "./model-resolution.js";
import { buildWorkerPrompt } from "./prompts.js";
import { writeState } from "./state.js";

export interface InsertResult {
  ok: boolean;
  message: string;
  inserted?: string[];
}

async function persistFleetJson(fleet: ActiveFleet): Promise<void> {
  const path = join(fleet.fleetRoot, "fleet.json");
  const tmp = join(fleet.fleetRoot, `.fleet.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(fleet.spec, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

export async function insertWorkers(
  fleet: ActiveFleet,
  raw: unknown,
  registry: ModelRegistryLike,
): Promise<InsertResult> {
  if (fleet.state.status === "completed") {
    return { ok: false, message: "fleet is completed; relaunch a node instead of inserting" };
  }
  const list = Array.isArray(raw) ? raw : (raw as { workers?: unknown[] } | null)?.workers;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, message: "no workers to insert (expected an array or { \"workers\": [...] })" };
  }
  const candidate = {
    fleet_name: fleet.spec.fleet_name,
    type: "dag",
    config: fleet.spec.config,
    workers: [...fleet.spec.workers, ...list],
  };
  const v = validateFleetSpec(candidate);
  if (!v.ok) return { ok: false, message: `invalid node insertion:\n${v.errors.join("\n")}` };
  const fresh = v.spec.workers.slice(fleet.spec.workers.length);
  for (const w of fresh) {
    if (w.model) {
      const r = resolveModelReference(registry, w.model);
      if (!r.ok) return { ok: false, message: `worker "${w.id}" model: ${r.error}` };
      w.model = `${r.model.provider}/${r.model.id}`;
    }
  }
  try {
    for (const w of fresh) {
      await mkdir(join(fleet.fleetRoot, "workers", w.id, "output"), { recursive: true });
      const prompt = buildWorkerPrompt({ spec: v.spec, state: fleet.state, workerId: w.id, fleetRoot: fleet.fleetRoot });
      await writeFile(join(fleet.fleetRoot, "workers", w.id, "prompt.md"), prompt, "utf-8");
    }
    if (!fleet.running) {
      const nodes = { ...fleet.state.nodes };
      for (const w of fresh) {
        nodes[w.id] = { status: "pending" as const, turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
      }
      fleet.state = { ...fleet.state, nodes };
      await writeState(fleet.fleetRoot, fleet.state);
    }
  } catch (e: unknown) {
    return { ok: false, message: `insert failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  fleet.spec.workers.push(...fresh);
  await persistFleetJson(fleet);
  const ids = fresh.map((w) => w.id);
  return { ok: true, message: `inserted ${ids.join(", ")}`, inserted: ids };
}
