import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalModelRef, formatModelError, resolveModelReference } from "./model-resolution.js";
import type { ModelRegistryLike } from "./model-resolution.js";
import { THINKING_LEVELS } from "./types.js";
import type { ThinkingLevelName } from "./types.js";

export interface FleetPreferences {
  max_concurrent?: number;
  model?: string;
  effort?: ThinkingLevelName;
  warn_cost_usd?: number;
}

export const PREFERENCE_KEYS = ["max_concurrent", "model", "effort", "warn_cost_usd"] as const;

export function defaultPreferencesPath(): string {
  return join(homedir(), ".pi", "agent", "fleet.json");
}

export async function loadPreferences(path: string = defaultPreferencesPath()): Promise<FleetPreferences> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const prefs: FleetPreferences = {};
    if (typeof raw.max_concurrent === "number" && Number.isInteger(raw.max_concurrent) && raw.max_concurrent >= 1) {
      prefs.max_concurrent = raw.max_concurrent;
    }
    if (typeof raw.model === "string" && raw.model.length > 0) prefs.model = raw.model;
    if (typeof raw.effort === "string" && THINKING_LEVELS.includes(raw.effort as ThinkingLevelName)) {
      prefs.effort = raw.effort as ThinkingLevelName;
    }
    if (typeof raw.warn_cost_usd === "number" && Number.isFinite(raw.warn_cost_usd) && raw.warn_cost_usd >= 0) {
      prefs.warn_cost_usd = raw.warn_cost_usd;
    }
    return prefs;
  } catch {
    return {};
  }
}

export async function savePreferences(prefs: FleetPreferences, path: string = defaultPreferencesPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf-8");
}

export function mergeFleetConfig(raw: unknown, prefs: FleetPreferences): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const fleet = raw as Record<string, unknown>;
  const cfg = (typeof fleet.config === "object" && fleet.config !== null && !Array.isArray(fleet.config))
    ? { ...(fleet.config as Record<string, unknown>) }
    : {};
  if (cfg.max_concurrent === undefined && prefs.max_concurrent !== undefined) cfg.max_concurrent = prefs.max_concurrent;
  if (cfg.model === undefined && prefs.model !== undefined) cfg.model = prefs.model;
  if (cfg.effort === undefined && prefs.effort !== undefined) cfg.effort = prefs.effort;
  if (cfg.warn_cost_usd === undefined && prefs.warn_cost_usd !== undefined) cfg.warn_cost_usd = prefs.warn_cost_usd;
  return { ...fleet, config: cfg };
}

export function validatePreferenceValue(
  key: string,
  value: string,
  registry?: ModelRegistryLike,
): { ok: true; parsed: number | string } | { ok: false; error: string } {
  switch (key) {
    case "max_concurrent": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: "max_concurrent must be an integer >= 1" };
      return { ok: true, parsed: n };
    }
    case "warn_cost_usd": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "warn_cost_usd must be a number >= 0" };
      return { ok: true, parsed: n };
    }
    case "effort": {
      if (!THINKING_LEVELS.includes(value as ThinkingLevelName)) {
        return { ok: false, error: `effort must be one of ${THINKING_LEVELS.join(", ")}` };
      }
      return { ok: true, parsed: value };
    }
    case "model": {
      if (value.trim().length === 0) return { ok: false, error: "model must be non-empty" };
      if (registry) {
        const r = resolveModelReference(registry, value.trim());
        if (!r.ok) return { ok: false, error: formatModelError(registry, "preference model", value.trim(), r.error) };
        return { ok: true, parsed: canonicalModelRef(r.model) };
      }
      return { ok: true, parsed: value.trim() };
    }
    default:
      return { ok: false, error: `unknown preference "${key}" (keys: ${PREFERENCE_KEYS.join(", ")})` };
  }
}

export function setPreference(
  prefs: FleetPreferences,
  key: string,
  value: string,
  registry?: ModelRegistryLike,
): { ok: true; prefs: FleetPreferences } | { ok: false; error: string } {
  const v = validatePreferenceValue(key, value, registry);
  if (!v.ok) return v;
  return { ok: true, prefs: { ...prefs, [key]: v.parsed } };
}

export function clearPreference(prefs: FleetPreferences, key: string): FleetPreferences {
  const next: Record<string, unknown> = { ...prefs };
  delete next[key];
  return next as FleetPreferences;
}
