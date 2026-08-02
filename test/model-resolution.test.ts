import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { FleetSpec } from "../src/types.js";
import { aliasesFor, resolveModelReference, validateFleetModels, type ModelRegistryLike } from "../src/model-resolution.js";

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

describe("aliasesFor", () => {
  it("collects id, name, alias, aliases", () => {
    const m = fakeModel("p", "m1", { name: "M One", alias: "mo", aliases: ["m-one", "one"] });
    expect(aliasesFor(m)).toEqual(["m1", "M One", "mo", "m-one", "one"]);
  });
});

describe("resolveModelReference", () => {
  const models = [fakeModel("openai", "gpt-5.4"), fakeModel("kimi", "k3"), fakeModel("kimi", "k3-256k")];

  it("resolves provider/id exactly", () => {
    const r = resolveModelReference(registryFor(models), "kimi/k3");
    expect(r.ok).toBe(true);
  });

  it("resolves bare id", () => {
    const r = resolveModelReference(registryFor(models), "gpt-5.4");
    expect(r.ok && r.model.provider).toBe("openai");
  });

  it("ambiguous match errors with candidates", () => {
    const dupes = [fakeModel("a", "x"), fakeModel("b", "x")];
    const r = resolveModelReference(registryFor(dupes), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ambiguous");
  });

  it("not found errors", () => {
    const r = resolveModelReference(registryFor(models), "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  it("falls back to getAll when getAvailable is empty", () => {
    const r = resolveModelReference(registryFor(models, []), "k3");
    expect(r.ok).toBe(true);
  });
});

describe("validateFleetModels", () => {
  const models = [fakeModel("openai", "gpt-5.4")];
  const base: FleetSpec = {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1, model: "gpt-5.4" },
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [], model: "gpt-5.4" }],
  };

  it("ok when all refs resolve", () => {
    expect(validateFleetModels(base, registryFor(models)).ok).toBe(true);
  });

  it("ok when no models specified", () => {
    const none: FleetSpec = {
      fleet_name: "t", type: "dag",
      config: { max_concurrent: 1 },
      workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
    };
    expect(validateFleetModels(none, registryFor(models)).ok).toBe(true);
  });

  it("collects errors for bad config and worker refs", () => {
    const bad: FleetSpec = {
      fleet_name: "t", type: "dag",
      config: { max_concurrent: 1, model: "nope-1" },
      workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [], model: "nope-2" }],
    };
    const r = validateFleetModels(bad, registryFor(models));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("config.model"))).toBe(true);
      expect(r.errors.some((e) => e.includes('worker "a"'))).toBe(true);
    }
  });

  it("reports each distinct bad ref once", () => {
    const dup: FleetSpec = {
      fleet_name: "t", type: "dag",
      config: { max_concurrent: 1 },
      workers: [
        { id: "a", type: "research", task: "t", depends_on: [], outputs: [], model: "nope" },
        { id: "b", type: "research", task: "t", depends_on: [], outputs: [], model: "nope" },
      ],
    };
    const r = validateFleetModels(dup, registryFor(models));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(2); // one per worker label
  });
});
