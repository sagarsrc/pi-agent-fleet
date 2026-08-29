import { rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveFleet } from "./controller.js";
import { persistFleetJson } from "./fleet-store.js";
import { resolveModelReference, type ModelRegistryLike } from "./model-resolution.js";
import { buildWorkerPrompt } from "./prompts.js";
import type { NodeStatus, ThinkingLevelName } from "./types.js";
import { THINKING_LEVELS } from "./types.js";

export type NodeEditKey = "model" | "effort" | "task";
export type ConfigEditKey = "max_concurrent" | "warn_cost_usd" | "max_cost_usd" | "worker_extensions" | "model" | "effort";

export interface EditResult {
  ok: boolean;
  message: string;
}

const EDITABLE_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set(["pending", "ready", "failed", "contract_failed", "killed", "blocked"]);

export async function editNode(
  fleet: ActiveFleet,
  nodeId: string,
  key: NodeEditKey,
  value: string,
  registry: ModelRegistryLike,
): Promise<EditResult> {
  const worker = fleet.spec.workers.find((w) => w.id === nodeId);
  const node = fleet.state.nodes[nodeId];
  if (!worker || !node) return { ok: false, message: `unknown node "${nodeId}"` };
  if (!EDITABLE_NODE_STATUSES.has(node.status)) {
    return { ok: false, message: `node "${nodeId}" is ${node.status}; only pending, blocked, failed, contract_failed, or killed nodes can be edited` };
  }
  switch (key) {
    case "model": {
      const r = resolveModelReference(registry, value);
      if (!r.ok) return { ok: false, message: r.error };
      worker.model = `${r.model.provider}/${r.model.id}`;
      break;
    }
    case "effort": {
      if (!THINKING_LEVELS.includes(value as ThinkingLevelName)) {
        return { ok: false, message: `effort must be one of ${THINKING_LEVELS.join(", ")}` };
      }
      worker.effort = value as ThinkingLevelName;
      break;
    }
    case "task": {
      if (value.trim().length === 0) return { ok: false, message: "task must be non-empty" };
      worker.task = value;
      const promptPath = join(fleet.fleetRoot, "workers", nodeId, "prompt.md");
      try {
        await stat(promptPath);
        const prompt = buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: nodeId, fleetRoot: fleet.fleetRoot });
        const tmp = join(fleet.fleetRoot, "workers", nodeId, `.prompt.md.${process.pid}.${Date.now()}.tmp`);
        await writeFile(tmp, prompt, "utf-8");
        await rename(tmp, promptPath);
      } catch {
        // prompt.md not written yet — nothing to regenerate
      }
      break;
    }
    default:
      return { ok: false, message: `unknown node edit key "${String(key)}" (keys: model, effort, task)` };
  }
  await persistFleetJson(fleet);
  return { ok: true, message: `node "${nodeId}" ${key} updated` };
}

export async function editConfig(
  fleet: ActiveFleet,
  key: ConfigEditKey,
  value: string,
  registry: ModelRegistryLike,
): Promise<EditResult> {
  switch (key) {
    case "max_concurrent": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return { ok: false, message: "max_concurrent must be an integer >= 1" };
      fleet.spec.config.max_concurrent = n;
      break;
    }
    case "warn_cost_usd": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return { ok: false, message: "warn_cost_usd must be a number >= 0" };
      fleet.spec.config.warn_cost_usd = n;
      break;
    }
    case "max_cost_usd": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return { ok: false, message: "max_cost_usd must be a number >= 0" };
      fleet.spec.config.max_cost_usd = n;
      break;
    }
    case "worker_extensions": {
      // accept JSON array or comma-separated string
      let list: string[];
      try {
        const parsed: unknown = JSON.parse(value);
        list = Array.isArray(parsed) ? parsed.map(String) : [value];
      } catch {
        list = value.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (list.some((s) => s.length === 0)) return { ok: false, message: "worker_extensions must be non-empty strings" };
      fleet.spec.config.worker_extensions = list;
      break;
    }
    case "model": {
      const r = resolveModelReference(registry, value);
      if (!r.ok) return { ok: false, message: r.error };
      fleet.spec.config.model = `${r.model.provider}/${r.model.id}`;
      break;
    }
    case "effort": {
      if (!THINKING_LEVELS.includes(value as ThinkingLevelName)) {
        return { ok: false, message: `effort must be one of ${THINKING_LEVELS.join(", ")}` };
      }
      fleet.spec.config.effort = value as ThinkingLevelName;
      break;
    }
    default:
      return { ok: false, message: `unknown config key "${String(key)}" (keys: max_concurrent, warn_cost_usd, max_cost_usd, worker_extensions, model, effort)` };
  }
  await persistFleetJson(fleet);
  return { ok: true, message: `config.${key} updated` };
}
