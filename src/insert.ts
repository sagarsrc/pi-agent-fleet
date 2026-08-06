import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveFleet } from "./controller.js";
import { validateFleetSpec } from "./dag.js";
import { persistFleetJson } from "./fleet-store.js";
import { resolveModelReference, type ModelRegistryLike } from "./model-resolution.js";
import { buildWorkerPrompt } from "./prompts.js";
import { writeState } from "./state.js";

export interface InsertResult {
  ok: boolean;
  message: string;
  inserted?: string[];
}

async function insertWorkersSerialized(
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
      const next = { ...fleet.state, nodes };
      await writeState(fleet.fleetRoot, next);
      fleet.state = next;
    }
  } catch (e: unknown) {
    return { ok: false, message: `insert failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  fleet.spec.workers.push(...fresh);
  try {
    await persistFleetJson(fleet);
  } catch (e: unknown) {
    fleet.spec.workers.length -= fresh.length;
    return { ok: false, message: `insert failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ids = fresh.map((w) => w.id);
  return { ok: true, message: `inserted ${ids.join(", ")}`, inserted: ids };
}

const insertQueues = new WeakMap<ActiveFleet, Promise<unknown>>();

export async function insertWorkers(
  fleet: ActiveFleet,
  raw: unknown,
  registry: ModelRegistryLike,
): Promise<InsertResult> {
  const prev = insertQueues.get(fleet) ?? Promise.resolve();
  const run = prev.then(() => insertWorkersSerialized(fleet, raw, registry));
  insertQueues.set(fleet, run.catch(() => {}));
  return run;
}
