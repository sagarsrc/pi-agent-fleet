import type { Api, Model } from "@earendil-works/pi-ai";

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
  tiers.push(pool.filter((m) => byAlias(m, (a) => a.includes(needle))));

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
