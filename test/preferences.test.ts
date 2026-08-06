import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearPreference,
  loadPreferences,
  mergeFleetConfig,
  savePreferences,
  setPreference,
  validatePreferenceValue,
} from "../src/preferences.js";
import { fakeModel, registryFor } from "./fakes.js";

async function tmpPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "fleet-prefs-")), "fleet.json");
}

describe("loadPreferences", () => {
  it("returns {} when the file is missing", async () => {
    expect(await loadPreferences(await tmpPath())).toEqual({});
  });

  it("returns {} when the file is corrupt", async () => {
    const p = await tmpPath();
    await writeFile(p, "{not json", "utf-8");
    expect(await loadPreferences(p)).toEqual({});
  });

  it("keeps only valid fields", async () => {
    const p = await tmpPath();
    await writeFile(p, JSON.stringify({
      max_concurrent: 8, model: "p/m", effort: "high", warn_cost_usd: 5,
      bogus: true,
    }), "utf-8");
    expect(await loadPreferences(p)).toEqual({ max_concurrent: 8, model: "p/m", effort: "high", warn_cost_usd: 5 });
  });

  it("drops invalid field values", async () => {
    const p = await tmpPath();
    await writeFile(p, JSON.stringify({ max_concurrent: 0, effort: "ludicrous", warn_cost_usd: -1 }), "utf-8");
    expect(await loadPreferences(p)).toEqual({});
  });
});

describe("savePreferences + loadPreferences roundtrip", () => {
  it("persists and reloads", async () => {
    const p = await tmpPath();
    await savePreferences({ max_concurrent: 6, effort: "low" }, p);
    expect(await loadPreferences(p)).toEqual({ max_concurrent: 6, effort: "low" });
    const raw = await readFile(p, "utf-8");
    expect(JSON.parse(raw).max_concurrent).toBe(6);
  });
});

describe("mergeFleetConfig", () => {
  const prefs = { max_concurrent: 8, model: "p/m", effort: "high" as const, warn_cost_usd: 5 };

  it("fills absent config fields from prefs", () => {
    const merged = mergeFleetConfig({ fleet_name: "t", type: "dag", workers: [{ id: "a", type: "research", task: "t" }] }, prefs) as { config: Record<string, unknown> };
    expect(merged.config).toMatchObject({ max_concurrent: 8, model: "p/m", effort: "high", warn_cost_usd: 5 });
  });

  it("never overrides explicit config fields", () => {
    const merged = mergeFleetConfig({ fleet_name: "t", type: "dag", config: { max_concurrent: 2, model: "x/y" }, workers: [] }, prefs) as { config: Record<string, unknown> };
    expect(merged.config.max_concurrent).toBe(2);
    expect(merged.config.model).toBe("x/y");
    expect(merged.config.effort).toBe("high");
  });

  it("passes through non-object input", () => {
    expect(mergeFleetConfig("nope", prefs)).toBe("nope");
  });
});

describe("validatePreferenceValue", () => {
  it("accepts valid values", () => {
    expect(validatePreferenceValue("max_concurrent", "8")).toEqual({ ok: true, parsed: 8 });
    expect(validatePreferenceValue("warn_cost_usd", "2.5")).toEqual({ ok: true, parsed: 2.5 });
    expect(validatePreferenceValue("effort", "xhigh")).toEqual({ ok: true, parsed: "xhigh" });
    expect(validatePreferenceValue("model", " p/m ")).toEqual({ ok: true, parsed: "p/m" });
  });

  it("rejects invalid values", () => {
    expect(validatePreferenceValue("max_concurrent", "0").ok).toBe(false);
    expect(validatePreferenceValue("max_concurrent", "2.5").ok).toBe(false);
    expect(validatePreferenceValue("warn_cost_usd", "-1").ok).toBe(false);
    expect(validatePreferenceValue("effort", "maxed").ok).toBe(false);
    expect(validatePreferenceValue("model", "  ").ok).toBe(false);
    expect(validatePreferenceValue("nope", "1").ok).toBe(false);
  });
});

describe("setPreference with registry", () => {
  it("rejects unknown model preference with registry suggestions", () => {
    const r = setPreference({}, "model", "kimi-for-coding/k2.7", registryFor([fakeModel("kimi-coding", "kimi-for-coding")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kimi-coding/kimi-for-coding");
  });

  it("stores canonical model preference", () => {
    const r = setPreference({}, "model", "kimi-for-coding", registryFor([fakeModel("kimi-coding", "kimi-for-coding")]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prefs.model).toBe("kimi-coding/kimi-for-coding");
  });
});

describe("setPreference / clearPreference", () => {
  it("sets and clears keys", () => {
    const set = setPreference({}, "max_concurrent", "8");
    expect(set).toEqual({ ok: true, prefs: { max_concurrent: 8 } });
    expect(clearPreference({ max_concurrent: 8, effort: "low" }, "max_concurrent")).toEqual({ effort: "low" });
    expect(setPreference({}, "max_concurrent", "0").ok).toBe(false);
  });
});
