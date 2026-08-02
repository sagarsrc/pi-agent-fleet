import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistryLike } from "../src/model-resolution.js";

export function fakeModel(
  provider: string,
  id: string,
  extra: { name?: string; alias?: string; aliases?: string[] } = {},
): Model<Api> {
  return {
    provider,
    id,
    name: extra.name ?? id,
    ...(extra.alias ? { alias: extra.alias } : {}),
    ...(extra.aliases ? { aliases: extra.aliases } : {}),
  } as unknown as Model<Api>;
}

export function registryFor(models: Model<Api>[], available?: Model<Api>[]): ModelRegistryLike {
  return { getAvailable: () => available ?? models, getAll: () => models };
}
