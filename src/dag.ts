import type { FleetSpec, OutputKind, WorkerSpec, WorkerType } from "./types.js";

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
  const model = typeof cfg.model === "string" ? cfg.model : "k2p6";
  const warnCost = typeof cfg.warn_cost_usd === "number" ? cfg.warn_cost_usd : undefined;

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
    }
    workers.push({
      id,
      type,
      task: String(w.task ?? ""),
      model: typeof w.model === "string" ? w.model : undefined,
      depends_on: Array.isArray(w.depends_on) ? (w.depends_on as string[]) : [],
      outputs: outputs.map((o) => ({ path: String(o.path), kind: o.kind as OutputKind, required: o.required !== false })),
    });
  }
  const idSet = new Set(workers.map((w) => w.id));
  for (const w of workers) {
    for (const d of w.depends_on) {
      if (!idSet.has(d)) errors.push(`worker "${w.id}": unknown dependency "${d}"`);
    }
  }

  const spec: FleetSpec = {
    fleet_name: String(r?.fleet_name ?? ""),
    type: "dag",
    config: { max_concurrent: maxConcurrent, model, warn_cost_usd: warnCost },
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
