import type { Api, Model } from "@earendil-works/pi-ai";
import type { FleetSpec } from "./types.js";

export interface ModelRegistryLike {
  getAvailable(): Model<Api>[];
  getAll(): Model<Api>[];
}

export function aliasesFor(model: Model<Api>): string[] {
  const extra = model as Model<Api> & { alias?: unknown; aliases?: unknown };
  return [
    model.id,
    model.name,
    ...(typeof extra.alias === "string" ? [extra.alias] : []),
    ...(Array.isArray(extra.aliases) ? extra.aliases.filter((a): a is string => typeof a === "string") : []),
  ];
}

export function canonicalModelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function listModelRefs(registry: ModelRegistryLike, limit = 40): string[] {
  const models = registry.getAvailable().length > 0 ? registry.getAvailable() : registry.getAll();
  return [...new Map(models.map((m) => [canonicalModelRef(m), m])).keys()].slice(0, limit);
}

export function suggestModelRefs(registry: ModelRegistryLike, ref: string, limit = 8): string[] {
  const needle = ref.toLowerCase();
  return listModelRefs(registry, 200)
    .filter((r) => r.toLowerCase().includes(needle) || needle.split(/[/-]/).some((p) => p.length > 2 && r.toLowerCase().includes(p)))
    .slice(0, limit);
}

export function formatModelError(registry: ModelRegistryLike, label: string, ref: string, error: string): string {
  const suggestions = suggestModelRefs(registry, ref);
  const available = listModelRefs(registry);
  return [
    `${label}: ${error}`,
    suggestions.length > 0 ? `suggestions: ${suggestions.join(", ")}` : undefined,
    `available models: ${available.join(", ")}`,
  ].filter(Boolean).join("\n");
}

export function resolveModelReference(
  registry: ModelRegistryLike,
  ref: string,
): { ok: true; model: Model<Api> } | { ok: false; error: string } {
  const models = registry.getAvailable();
  const pool = models.length > 0 ? models : registry.getAll();
  const needle = ref.toLowerCase();
  const canonical = (m: Model<Api>) => `${m.provider}/${m.id}`.toLowerCase();
  const byAlias = (m: Model<Api>, pred: (v: string) => boolean) => aliasesFor(m).some((a) => pred(a.toLowerCase()));

  const tiers: Model<Api>[][] = [];
  if (needle.includes("/")) {
    tiers.push(pool.filter((m) => canonical(m) === needle));
    const [provider, ...rest] = needle.split("/");
    const alias = rest.join("/");
    tiers.push(pool.filter((m) => m.provider.toLowerCase() === provider && byAlias(m, (a) => a === alias)));
  }
  tiers.push(pool.filter((m) => m.id.toLowerCase() === needle));
  tiers.push(pool.filter((m) => byAlias(m, (a) => a === needle)));
  tiers.push(pool.filter((m) => byAlias(m, (a) => a.startsWith(needle))));

  for (const tier of tiers) {
    const unique = [...new Map(tier.map((m) => [`${m.provider}/${m.id}`, m])).values()];
    if (unique.length === 1) return { ok: true, model: unique[0] };
    if (unique.length > 1) {
      return {
        ok: false,
        error: `model "${ref}" is ambiguous: ${unique.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
      };
    }
  }
  return { ok: false, error: `model "${ref}" not found` };
}

export function validateFleetModels(
  spec: FleetSpec,
  registry: ModelRegistryLike,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const refs: Array<{ label: string; ref: string }> = [];
  if (spec.config.model) refs.push({ label: "config.model", ref: spec.config.model });
  for (const w of spec.workers) {
    if (w.model) refs.push({ label: `worker "${w.id}" model`, ref: w.model });
  }
  const seen = new Set<string>();
  for (const { label, ref } of refs) {
    const key = `${label}\0${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = resolveModelReference(registry, ref);
    if (!r.ok) errors.push(formatModelError(registry, label, ref, r.error));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
