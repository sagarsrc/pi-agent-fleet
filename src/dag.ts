import type { ContractOutput, FleetSpec, GateKind, JsonOutputSchema, LoopConfig, OutputKind, ThinkingLevelName, WorkerSpec, WorkerType } from "./types.js";
import { THINKING_LEVELS } from "./types.js";

export class CycleError extends Error {
  constructor(public remaining: string[]) {
    super(`CYCLE:${remaining.join(",")}`);
    this.name = "CycleError";
  }
}

const WORKER_TYPES: WorkerType[] = ["research", "code-run", "reviewer", "write", "read-only"];
const KINDS: OutputKind[] = ["markdown", "file-exists", "verdict", "json", "yaml"];

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function topoLayers(spec: FleetSpec): string[][] {
  const ids = spec.workers.map((w) => w.id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const rev = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const w of spec.workers) {
    for (const d of w.depends_on) {
      indeg.set(w.id, (indeg.get(w.id) ?? 0) + 1);
      rev.get(d)?.push(w.id);
    }
  }
  const layers: string[][] = [];
  let current = ids.filter((id) => indeg.get(id) === 0);
  let placed = 0;
  while (current.length > 0) {
    layers.push(current);
    placed += current.length;
    const next: string[] = [];
    for (const n of current) {
      for (const m of rev.get(n) ?? []) {
        const v = (indeg.get(m) ?? 0) - 1;
        indeg.set(m, v);
        if (v === 0) next.push(m);
      }
    }
    current = next;
  }
  if (placed !== ids.length) {
    throw new CycleError(ids.filter((id) => !layers.flat().includes(id)));
  }
  return layers;
}

export function getDependents(spec: FleetSpec, nodeId: string): string[] {
  return spec.workers.filter((w) => w.depends_on.includes(nodeId)).map((w) => w.id);
}

export function findRepoOutputOwnershipConflicts(workers: WorkerSpec[]): string[] {
  const claims = new Map<string, string[]>();
  for (const w of workers) {
    for (const o of w.outputs) {
      if (!o.path.startsWith("output/")) {
        const list = claims.get(o.path) ?? [];
        list.push(w.id);
        claims.set(o.path, list);
      }
    }
  }
  const errors: string[] = [];
  const byId = new Map(workers.map((w) => [w.id, w]));
  for (const [path, ids] of claims) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const aBeforeB = byId.get(a)!.depends_on.includes(b);
        const bBeforeA = byId.get(b)!.depends_on.includes(a);
        if (!aBeforeB && !bBeforeA) {
          errors.push(`repo output ownership conflict: "${path}" claimed by "${a}" and "${b}" without ordered handoff`);
        }
      }
    }
  }
  return errors;
}

function hasIntegratorPath(workers: WorkerSpec[]): boolean {
  const worktreeIds = new Set(workers.filter((w) => w.worktree).map((w) => w.id));
  if (worktreeIds.size < 2) return true;
  return workers.some((w) => {
    if (w.worktree) return false;
    const deps = new Set(w.depends_on);
    for (const id of worktreeIds) if (!deps.has(id)) return false;
    return true;
  });
}

export function validateFleetSpec(
  raw: unknown,
): { ok: true; spec: FleetSpec; layers: string[][] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const r = raw as Record<string, unknown>;
  if (typeof r?.fleet_name !== "string" || !ID_RE.test(r.fleet_name)) {
    errors.push("fleet_name must be non-empty kebab-case");
  }
  if (r?.type !== "dag") errors.push('type must be "dag"');
  const cfg = (r?.config ?? {}) as Record<string, unknown>;
  const maxConcurrent = typeof cfg.max_concurrent === "number" ? cfg.max_concurrent : 4;
  if (maxConcurrent < 1) errors.push("config.max_concurrent must be >= 1");
  const model = typeof cfg.model === "string" ? cfg.model : undefined;
  const effort = typeof cfg.effort === "string" ? cfg.effort as ThinkingLevelName : undefined;
  if (effort !== undefined && !THINKING_LEVELS.includes(effort)) {
    errors.push(`config.effort must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const warnCost = typeof cfg.warn_cost_usd === "number" ? cfg.warn_cost_usd : undefined;
  const maxCost = typeof cfg.max_cost_usd === "number" ? cfg.max_cost_usd : undefined;
  const workerExtensions = Array.isArray(cfg.worker_extensions)
    ? (cfg.worker_extensions as unknown[]).filter((e): e is string => typeof e === "string")
    : undefined;

  const rawWorkers = Array.isArray(r?.workers) ? (r.workers as Record<string, unknown>[]) : [];
  if (rawWorkers.length === 0) errors.push("at least one worker required");

  const seen = new Set<string>();
  const workers: WorkerSpec[] = [];
  for (const w of rawWorkers) {
    const id = typeof w.id === "string" ? w.id : "";
    if (!ID_RE.test(id)) errors.push(`worker id "${id}" must match ${ID_RE}`);
    if (seen.has(id)) errors.push(`duplicate worker id "${id}"`);
    seen.add(id);
    const type = w.type as WorkerType;
    if (!WORKER_TYPES.includes(type)) errors.push(`worker "${id}": bad type "${String(w.type)}"`);
    if (typeof w.task !== "string" || w.task.length === 0) errors.push(`worker "${id}": task required`);
    const outputs = (Array.isArray(w.outputs) ? w.outputs : []) as Record<string, unknown>[];
    for (const o of outputs) {
      if (!KINDS.includes(o.kind as OutputKind)) errors.push(`worker "${id}": bad output kind "${String(o.kind)}"`);
      if (typeof o.path !== "string" || o.path.length === 0) errors.push(`worker "${id}": output path required`);
      if (typeof o.path === "string" && o.path.length > 0) {
        const segments = o.path.split(/[/\\]/);
        if (o.path.startsWith("/") || /^[A-Za-z]:/.test(o.path) || segments.includes("..")) {
          errors.push(`worker "${id}": output path must be relative and stay within the repo`);
        }
      }
      if (o.schema !== undefined) {
        if (o.kind !== "json") {
          errors.push(`worker "${id}": output schema only allowed with kind "json"`);
        } else if (typeof o.schema !== "object" || o.schema === null || Array.isArray(o.schema)) {
          errors.push(`worker "${id}": output schema must be an object`);
        } else {
          const s = o.schema as Record<string, unknown>;
          for (const name of ["required_keys", "number_keys"] as const) {
            const keys = s[name];
            if (keys !== undefined && (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || k.length === 0))) {
              errors.push(`worker "${id}": schema.${name} must be an array of non-empty strings`);
            }
          }
        }
      }
    }
    const wEffort = typeof w.effort === "string" ? w.effort as ThinkingLevelName : undefined;
    if (wEffort !== undefined && !THINKING_LEVELS.includes(wEffort)) {
      errors.push(`worker "${id}": bad effort "${String(w.effort)}"`);
    }
    workers.push({
      id,
      type,
      task: String(w.task ?? ""),
      model: typeof w.model === "string" ? w.model : undefined,
      effort: wEffort,
      depends_on: Array.isArray(w.depends_on) ? (w.depends_on as string[]) : [],
      outputs: outputs.map((o) => {
        const out: ContractOutput = { path: String(o.path), kind: o.kind as OutputKind, required: o.required !== false };
        const s = o.schema;
        if (o.kind === "json" && typeof s === "object" && s !== null && !Array.isArray(s)) {
          const rec = s as Record<string, unknown>;
          const schema: JsonOutputSchema = {};
          if (Array.isArray(rec.required_keys)) schema.required_keys = rec.required_keys as string[];
          if (Array.isArray(rec.number_keys)) schema.number_keys = rec.number_keys as string[];
          out.schema = schema;
        }
        return out;
      }),
      iterate: w.iterate !== false,
      worktree: w.worktree === true,
    });
  }
  const idSet = new Set(workers.map((w) => w.id));
  for (const w of workers) {
    for (const d of w.depends_on) {
      if (!idSet.has(d)) errors.push(`worker "${w.id}": unknown dependency "${d}"`);
    }
  }

  const worktreeIds = new Set(workers.filter((w) => w.worktree).map((w) => w.id));
  if (worktreeIds.size >= 2) {
    if (!workers.some((w) => w.id === "fleet-integrator")) {
      workers.push({
        id: "fleet-integrator",
        type: "code-run",
        task: `Merge worktree branches in order: ${[...worktreeIds].join(", ")}. Verify the combined repo is consistent and commit if needed.`,
        depends_on: [...worktreeIds],
        outputs: [],
      });
    }
    if (!hasIntegratorPath(workers)) {
      errors.push("multiple worktree workers require an integrator that depends on all worktree workers");
    }
  }
  errors.push(...findRepoOutputOwnershipConflicts(workers));

  let loopConfig: LoopConfig | undefined;
  if (cfg.loop !== undefined && cfg.loop !== null) {
    if (typeof cfg.loop !== "object" || Array.isArray(cfg.loop)) {
      errors.push("config.loop must be an object");
    } else {
      const loop = cfg.loop as Record<string, unknown>;
      const maxIterations = loop.max_iterations;
      if (typeof maxIterations !== "number" || !Number.isInteger(maxIterations) || maxIterations < 1) {
        errors.push("loop.max_iterations must be an integer >= 1");
      }
      const gate = loop.gate;
      if (gate !== "reviewer" && gate !== "none") {
        errors.push('loop.gate must be "reviewer" or "none"');
      }
      const lgtmCount = loop.lgtm_count;
      const lgtmCountProvided = lgtmCount !== undefined;
      if (lgtmCountProvided) {
        if (typeof lgtmCount !== "number" || !Number.isInteger(lgtmCount) || lgtmCount < 1) {
          errors.push("loop.lgtm_count must be an integer >= 1");
        } else if (gate === "none") {
          errors.push("loop.lgtm_count is not allowed with gate none");
        } else if (typeof maxIterations === "number" && Number.isInteger(maxIterations) && maxIterations >= 1 && lgtmCount > maxIterations) {
          errors.push("loop.lgtm_count must be <= max_iterations");
        }
      }
      if (gate === "reviewer" && typeof maxIterations === "number" && Number.isInteger(maxIterations) && maxIterations >= 1) {
        const verdictNodes = workers.filter((w) => w.outputs.some((o) => o.kind === "verdict"));
        if (verdictNodes.length !== 1) {
          errors.push(`gate reviewer requires exactly one verdict-output node, found ${verdictNodes.length}`);
        } else {
          const verdictNode = verdictNodes[0];
          if (verdictNode.iterate === false) {
            errors.push(`verdict node "${verdictNode.id}" must have iterate enabled`);
          } else {
            const dependents = workers.filter((w) => w.depends_on.includes(verdictNode.id));
            if (dependents.length > 0) {
              errors.push(`verdict node "${verdictNode.id}" must be a sink, but is depended on by ${dependents.map((w) => w.id).join(", ")}`);
            }
          }
        }
      }
      if (gate === "none" && workers.every((w) => w.iterate === false)) {
        errors.push("gate none requires at least one replay node (iterate: false on all nodes makes the loop a no-op)");
      }
      if (errors.length === 0) {
        loopConfig = {
          gate: gate as GateKind,
          max_iterations: maxIterations as number,
          lgtm_count: lgtmCountProvided ? (lgtmCount as number) : 1,
        };
      }

      const byId = new Map(workers.map((w) => [w.id, w]));
      for (const w of workers) {
        if (w.iterate !== false) continue;
        for (const d of w.depends_on) {
          const dep = byId.get(d);
          if (dep && dep.iterate !== false) {
            errors.push(`run-once node "${w.id}" depends on replay node "${d}"`);
          }
        }
      }
    }
  }

  const spec: FleetSpec = {
    fleet_name: String(r?.fleet_name ?? ""),
    type: "dag",
    config: { max_concurrent: maxConcurrent, model, effort, warn_cost_usd: warnCost, max_cost_usd: maxCost, worker_extensions: workerExtensions, loop: loopConfig },
    workers,
  };

  let layers: string[][] = [];
  if (errors.length === 0) {
    try {
      layers = topoLayers(spec);
    } catch (e) {
      if (e instanceof CycleError) errors.push(e.message);
      else throw e;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec, layers };
}
