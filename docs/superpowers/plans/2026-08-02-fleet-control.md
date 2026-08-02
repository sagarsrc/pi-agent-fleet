# Fleet Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent fleet preferences (`/fleet configure`), single-node kill, mid-run editing of pending nodes and fleet config, and a `fleet_design` tool that drafts a fleet DAG from plain requirements (todo.md #4, #7, #8, #10).

**Architecture:** New modules `preferences.ts`, `edits.ts`, `planner.ts`; kill plumbing through `runner.ts` (onSession) and `scheduler.ts` (nodeKills); command/tool wiring in `command.ts`/`tools.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, pi extension API, typebox.

**Worktree root (all paths resolve here):** `/Users/sagar/work/pi-fleet-extension/.worktrees/fleet-control`

## Global Constraints

- All local imports use the `.js` suffix (NodeNext ESM).
- `npm test` AND `npm run typecheck` green at the end of every task.
- No new dependencies.
- Commit style: conventional (`feat:`, `fix:`, `test:`). One commit per task.
- Preferences live at `~/.pi/agent/fleet.json` (path always injectable); corrupt/missing file ⇒ treated as `{}`, never throws.
- Kill semantics: fleet-wide `all` unchanged; node kill ⇒ status `killed` (not `failed`); dependents become `blocked` (existing behavior); fleet-level final status logic is NOT changed by this plan.
- Edit semantics: only `pending`/`ready` nodes editable; every successful edit persists `fleet.json`; config edits take live effect (scheduler re-reads `spec.config` each pass).
- `THINKING_LEVELS` becomes the single exported source of valid effort values in `src/types.ts`; `dag.ts` reuses it.
- `fleet_design` never creates a fleet root and never launches; its output text ends with: `Show this preview to the user. If they approve, call fleet_plan with this definition (fleet_launch only after their explicit confirmation).`

---

### Task 1: Preferences module + `/fleet configure` + plan-time merge

**Files:**
- Create: `src/preferences.ts`
- Create: `test/fakes.ts` (shared fake-model helpers)
- Modify: `src/types.ts` (export `THINKING_LEVELS`)
- Modify: `src/dag.ts` (reuse `THINKING_LEVELS`)
- Modify: `src/tools.ts` (merge prefs in `fleet_plan`)
- Modify: `src/command.ts` (`/fleet configure`)
- Test: `test/preferences.test.ts`

**Interfaces:**
- Produces: `FleetPreferences`, `defaultPreferencesPath()`, `loadPreferences(path?)`, `savePreferences(prefs, path?)`, `mergeFleetConfig(raw, prefs)`, `validatePreferenceValue(key, value)`, `setPreference(prefs, key, value)`, `clearPreference(prefs, key)`. `types.ts`: `THINKING_LEVELS: readonly ThinkingLevelName[]`.
- Consumes: existing modules unchanged in shape.

- [ ] **Step 1: Write the failing tests**

`test/fakes.ts`:

```typescript
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
```

In `test/model-resolution.test.ts`: delete the local `fakeModel`/`registryFor` definitions and import them instead: `import { fakeModel, registryFor } from "./fakes.js";` (keep all test bodies unchanged).

`test/preferences.test.ts`:

```typescript
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

describe("setPreference / clearPreference", () => {
  it("sets and clears keys", () => {
    const set = setPreference({}, "max_concurrent", "8");
    expect(set).toEqual({ ok: true, prefs: { max_concurrent: 8 } });
    expect(clearPreference({ max_concurrent: 8, effort: "low" }, "max_concurrent")).toEqual({ effort: "low" });
    expect(setPreference({}, "max_concurrent", "0").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/preferences.test.ts`
Expected: FAIL — `Cannot find module '../src/preferences.js'`

- [ ] **Step 3: Implement**

`src/types.ts` — after the `ThinkingLevelName` type add:

```typescript
export const THINKING_LEVELS: readonly ThinkingLevelName[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
```

`src/dag.ts` — replace the local `const EFFORTS: ThinkingLevelName[] = [...]` with `THINKING_LEVELS` imported from `./types.js` (add to the existing type import as a value import on its own line: `import { THINKING_LEVELS } from "./types.js";`). Replace both `EFFORTS.includes(...)` uses and the error message `${EFFORTS.join(", ")}` with `THINKING_LEVELS`.

`src/preferences.ts` (complete file):

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
): { ok: true; prefs: FleetPreferences } | { ok: false; error: string } {
  const v = validatePreferenceValue(key, value);
  if (!v.ok) return v;
  return { ok: true, prefs: { ...prefs, [key]: v.parsed } };
}

export function clearPreference(prefs: FleetPreferences, key: string): FleetPreferences {
  const next: Record<string, unknown> = { ...prefs };
  delete next[key];
  return next as FleetPreferences;
}
```

`src/tools.ts` — in `fleet_plan` execute, change the validation line to merge prefs first (add imports: `loadPreferences`, `mergeFleetConfig` from `./preferences.js`):

```typescript
const prefs = await loadPreferences();
const v = validateFleetSpec(mergeFleetConfig(params.fleet, prefs));
```

`src/command.ts` — add to the handler, before the final usage fallback (add imports: `clearPreference`, `loadPreferences`, `PREFERENCE_KEYS`, `savePreferences`, `setPreference` from `./preferences.js`):

```typescript
if (cmd === "configure") {
  const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
  const sub = parts[1];
  if (sub === "show") {
    const prefs = await loadPreferences();
    ctx.ui.notify(JSON.stringify(prefs, null, 2), "info");
    return;
  }
  if (sub === "set") {
    const key = parts[2];
    const value = parts.slice(3).join(" ");
    if (!key || !value) {
      ctx.ui.notify("usage: /fleet configure set <key> <value>", "warning");
      return;
    }
    const prefs = await loadPreferences();
    const r = setPreference(prefs, key, value);
    if (!r.ok) {
      ctx.ui.notify(r.error, "error");
      return;
    }
    await savePreferences(r.prefs);
    ctx.ui.notify(`preference ${key} saved`, "info");
    return;
  }
  // interactive wizard
  while (true) {
    const prefs = await loadPreferences();
    const options = PREFERENCE_KEYS.map((k) => `${k}: ${prefs[k] ?? "—"}`);
    const field = await ctx.ui.select("Fleet preferences (empty input clears a field):", [...options, "done"]);
    if (!field || field === "done") break;
    const key = field.split(":")[0] as (typeof PREFERENCE_KEYS)[number];
    const input = await ctx.ui.input(`${key} (current: ${prefs[key] ?? "—"}):`, "empty clears");
    if (input === undefined) break;
    const next = input.trim().length === 0
      ? clearPreference(prefs, key)
      : (() => {
          const r = setPreference(prefs, key, input.trim());
          if (!r.ok) return undefined;
          return r.prefs;
        })();
    if (next === undefined) {
      ctx.ui.notify(`invalid value for ${key}`, "error");
      continue;
    }
    await savePreferences(next);
  }
  ctx.ui.notify("preferences saved", "info");
  return;
}
```

Update the command `description` and the final usage `notify` string to: `"Fleet commands: /fleet viz, /fleet status, /fleet configure [show|set k v], /fleet clear, /fleet kill all, /fleet pause, /fleet resume, /fleet relaunch <node_id> [model]"`.

Note: `/fleet configure` currently sits behind the handler's top-level `if (!active)` guard. Move the `configure` branch ABOVE that guard (configure works without an active fleet). Structure: parse `cmd` first, handle `configure`, then the `if (!active)` guard, then the rest.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/preferences.ts src/types.ts src/dag.ts src/tools.ts src/command.ts test/preferences.test.ts test/fakes.ts test/model-resolution.test.ts
git commit -m "feat: fleet preferences with /fleet configure, merged into fleet_plan"
```

---

### Task 2: Single-node kill

**Files:**
- Modify: `src/runner.ts` (`onSession` hook)
- Modify: `src/scheduler.ts` (`nodeKills`)
- Modify: `src/controller.ts` (`sessions`, `killedNodes`, `killFleet`)
- Modify: `src/tools.ts` (fleet_plan cell init; `fleet_kill` description)
- Modify: `src/command.ts` (`/fleet kill <node>` usage text)
- Test: `test/scheduler.test.ts`, `test/runner.test.ts`, `test/controller.test.ts`

**Interfaces:**
- Produces: `RunWorkerOpts.onSession?: (session: AgentSessionLike) => void`; `RunFleetOpts.nodeKills?: ReadonlySet<string>`; `ActiveFleet.sessions: Map<string, AgentSessionLike>`; `ActiveFleet.killedNodes: Set<string>`.
- Consumes: existing kill/relaunch semantics unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/scheduler.test.ts`:

```typescript
it("marks a nodeKills pending node as killed and blocks dependents", async () => {
  const spawned: string[] = [];
  const s = await runFleet({
    spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
    spawn: async (id) => { spawned.push(id); return { ok: true, turns: 1, tokens: 10 }; },
    nodeKills: new Set(["a"]),
  });
  expect(s.nodes.a.status).toBe("killed");
  expect(s.nodes.b.status).toBe("blocked");
  expect(spawned).not.toContain("a");
});

it("failed spawn of a nodeKills node resolves to killed, not failed", async () => {
  const s = await runFleet({
    spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
    spawn: async () => ({ ok: false, turns: 1, tokens: 10, error: "aborted" }),
    nodeKills: new Set(["a"]),
  });
  expect(s.nodes.a.status).toBe("killed");
});
```

Append to `test/runner.test.ts`:

```typescript
it("invokes onSession with the created session", async () => {
  const fake = {
    prompt: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    dispose: () => {},
  };
  let seen: unknown;
  await runWorker({
    nodeId: "a",
    worker: { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    prompt: "p",
    repoCwd: "/tmp",
    sessionFactory: async () => fake,
    onSession: (s) => { seen = s; },
    onEvent: () => {},
  });
  expect(seen).toBe(fake);
});
```

Append to `test/controller.test.ts` (add `killFleet`, `activeFleet` to the controller import; `writeState` to the state import; `mkdtemp`/`tmpdir`/`join` imports as needed):

```typescript
describe("killFleet node targets", () => {
  async function plannedFleet(): Promise<ActiveFleet> {
    const fleet = runningFleet();
    fleet.fleetRoot = await mkdtemp(join(tmpdir(), "fleet-kill-"));
    fleet.running = false;
    fleet.state = initFleetState(fleet.spec);
    await writeState(fleet.fleetRoot, fleet.state);
    return fleet;
  }

  it("kills a pending node directly when the fleet is not running", async () => {
    const fleet = await plannedFleet();
    activeFleet.current = fleet;
    try {
      const msg = await killFleet("a");
      expect(msg).toBe('node "a" killed');
      expect(fleet.state.nodes.a.status).toBe("killed");
      const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
      expect(persisted.nodes.a.status).toBe("killed");
    } finally {
      activeFleet.current = undefined;
    }
  });

  it("rejects unknown nodes and terminal nodes", async () => {
    const fleet = await plannedFleet();
    activeFleet.current = fleet;
    try {
      expect(await killFleet("zzz")).toContain('unknown node "zzz"');
      fleet.state = patchNode(fleet.fleetRoot, fleet.state, "a", { status: "completed" });
      expect(await killFleet("a")).toContain("already completed");
    } finally {
      activeFleet.current = undefined;
    }
  });

  it("aborts the live session of a running node", async () => {
    const fleet = await plannedFleet();
    fleet.running = true;
    let aborted = false;
    fleet.sessions.set("a", {
      prompt: async () => {},
      abort: async () => { aborted = true; },
      subscribe: () => () => {},
      dispose: () => {},
    });
    fleet.state = patchNode(fleet.fleetRoot, fleet.state, "a", { status: "running" });
    activeFleet.current = fleet;
    try {
      const msg = await killFleet("a");
      expect(aborted).toBe(true);
      expect(fleet.killedNodes.has("a")).toBe(true);
      expect(msg).toContain('node "a" kill requested');
    } finally {
      activeFleet.current = undefined;
    }
  });
});
```

(`readFile` needs importing from `node:fs/promises` in that test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts test/runner.test.ts test/controller.test.ts`
Expected: FAIL — `nodeKills`/`onSession`/`sessions`/`killedNodes` do not exist.

- [ ] **Step 3: Implement**

`src/runner.ts`:
- `RunWorkerOpts` gains `onSession?: (session: AgentSessionLike) => void;`
- Immediately after the successful factory call: `opts.onSession?.(session);`

`src/scheduler.ts`:
- `RunFleetOpts` gains `nodeKills?: ReadonlySet<string>;`
- In the dispatch loop, inside the per-worker scan, after the `n.status !== "pending" && n.status !== "ready"` skip and BEFORE the `depsDone` check:

```typescript
if (opts.nodeKills?.has(w.id)) {
  await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
  continue;
}
```

- In the spawn result handler, replace the `if (!res.ok)` patch's status with:

```typescript
if (!res.ok) {
  const killed = opts.nodeKills?.has(w.id) === true;
  await patch(w.id, { status: killed ? "killed" : "failed", ended_at: new Date().toISOString(), turns: res.turns, tokens: res.tokens, cost_usd_estimate: res.cost ?? 0 });
  return;
}
```

`src/controller.ts`:
- `ActiveFleet` gains `sessions: Map<string, AgentSessionLike>;` and `killedNodes: Set<string>;` (import type `AgentSessionLike` from `./runner.js`).
- In `spawn`, pass `onSession: (s) => { fleet.sessions.set(nodeId, s); }` into `runWorker`, and capture the result so the session entry is removed:

```typescript
const res = await runWorker({ /* ...existing args..., */ onSession: (s) => { fleet.sessions.set(nodeId, s); } });
fleet.sessions.delete(nodeId);
return res;
```

- In the `runFleet({...})` call, add `nodeKills: fleet.killedNodes,`.
- Replace `killFleet` with:

```typescript
export async function killFleet(target: string): Promise<string> {
  const active = activeFleet.current;
  if (!active) return "no fleet planned yet";
  if (target === "all") {
    active.killSwitch.killed = true;
    return "fleet kill requested";
  }
  const worker = active.spec.workers.find((w) => w.id === target);
  const node = active.state.nodes[target];
  if (!worker || !node) return `unknown node "${target}"`;
  if (TERMINAL_NODE_STATUSES.has(node.status)) return `node "${target}" already ${node.status}`;
  active.killedNodes.add(target);
  const session = active.sessions.get(target);
  if (session) {
    await session.abort();
    return `node "${target}" kill requested`;
  }
  if (!active.running) {
    active.state = patchNode(active.fleetRoot, active.state, target, { status: "killed", ended_at: new Date().toISOString() });
    await writeState(active.fleetRoot, active.state);
    return `node "${target}" killed`;
  }
  return `node "${target}" kill requested (takes effect at next dispatch pass)`;
}
```

(Add `TERMINAL_NODE_STATUSES` to the types import in controller.ts.)

`src/tools.ts`:
- `fleet_plan` cell init gains `sessions: new Map(), killedNodes: new Set(),`.
- `fleet_kill` description: `"Request a fleet-wide kill (target \"all\") or kill a single node by worker id. Killing a running node aborts its session; killing a pending node marks it killed at the next dispatch pass. Killed nodes can be revived with fleet_relaunch."`; param description: `"all or a worker id"`.

`src/command.ts`: update the `/fleet kill` branch's usage texts and the command description/final usage string to `/fleet kill all|<node_id>`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts src/scheduler.ts src/controller.ts src/tools.ts src/command.ts test/scheduler.test.ts test/runner.test.ts test/controller.test.ts
git commit -m "feat: single-node kill with session abort, killed status, blocked dependents"
```

---

### Task 3: Mid-run edit (`/fleet edit` + `fleet_edit` tool)

**Files:**
- Create: `src/edits.ts`
- Modify: `src/command.ts` (`/fleet edit`)
- Modify: `src/tools.ts` (`fleet_edit` tool)
- Test: `test/edits.test.ts`

**Interfaces:**
- Produces: `editNode(fleet: ActiveFleet, nodeId: string, key: NodeEditKey, value: string, registry: ModelRegistryLike): Promise<{ ok: boolean; message: string }>`; `editConfig(fleet: ActiveFleet, key: ConfigEditKey, value: string, registry: ModelRegistryLike): Promise<{ ok: boolean; message: string }>`; `type NodeEditKey = "model" | "effort" | "task"`; `type ConfigEditKey = "max_concurrent" | "warn_cost_usd" | "model" | "effort"`.
- Consumes: `ActiveFleet` (controller), `resolveModelReference`/`ModelRegistryLike` (model-resolution), `buildWorkerPrompt` (prompts), `THINKING_LEVELS` (types).

- [ ] **Step 1: Write the failing tests**

`test/edits.test.ts`:

```typescript
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveFleet } from "../src/controller.js";
import { editConfig, editNode } from "../src/edits.js";
import { buildWorkerPrompt } from "../src/prompts.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { fakeModel, registryFor } from "./fakes.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "old task", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

async function fleetAt(status: "pending" | "running"): Promise<ActiveFleet> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-edit-"));
  let state = initFleetState(spec);
  if (status === "running") state = patchNode(fleetRoot, state, "a", { status: "running" });
  return {
    spec: structuredClone(spec),
    fleetRoot,
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: false,
    sessions: new Map(),
    killedNodes: new Set(),
  };
}

const registry = registryFor([fakeModel("openai", "gpt-5.4"), fakeModel("kimi", "k3")]);

describe("editNode", () => {
  it("sets a canonical model on a pending node and persists fleet.json", async () => {
    const fleet = await fleetAt("pending");
    const r = await editNode(fleet, "a", "model", "k3", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].model).toBe("kimi/k3");
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.workers[0].model).toBe("kimi/k3");
  });

  it("rejects edits to a non-pending node", async () => {
    const fleet = await fleetAt("running");
    const r = await editNode(fleet, "a", "model", "k3", registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("running");
  });

  it("rejects unknown nodes, unknown keys, and bad values", async () => {
    const fleet = await fleetAt("pending");
    expect((await editNode(fleet, "zzz", "model", "k3", registry)).ok).toBe(false);
    expect((await editNode(fleet, "a", "nope" as never, "x", registry)).message).toContain("unknown node edit key");
    expect((await editNode(fleet, "a", "model", "ghost", registry)).ok).toBe(false);
    expect((await editNode(fleet, "a", "effort", "maxed", registry)).ok).toBe(false);
  });

  it("sets effort on a pending node", async () => {
    const fleet = await fleetAt("pending");
    const r = await editNode(fleet, "b", "effort", "high", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[1].effort).toBe("high");
  });

  it("updates task and regenerates prompt.md when present", async () => {
    const fleet = await fleetAt("pending");
    const dir = join(fleet.fleetRoot, "workers", "a");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: "a", fleetRoot: fleet.fleetRoot }), "utf-8");
    const r = await editNode(fleet, "a", "task", "brand new task", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].task).toBe("brand new task");
    const prompt = await readFile(join(dir, "prompt.md"), "utf-8");
    expect(prompt).toContain("brand new task");
  });

  it("updates task without prompt.md present", async () => {
    const fleet = await fleetAt("pending");
    const r = await editNode(fleet, "a", "task", "another task", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].task).toBe("another task");
  });
});

describe("editConfig", () => {
  it("sets max_concurrent and persists", async () => {
    const fleet = await fleetAt("pending");
    const r = await editConfig(fleet, "max_concurrent", "8", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.config.max_concurrent).toBe(8);
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.config.max_concurrent).toBe(8);
  });

  it("validates values", async () => {
    const fleet = await fleetAt("pending");
    expect((await editConfig(fleet, "max_concurrent", "0", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "warn_cost_usd", "-2", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "effort", "maxed", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "model", "ghost", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "nope" as never, "1", registry)).message).toContain("unknown config key");
  });

  it("sets warn_cost_usd, effort, and canonical model", async () => {
    const fleet = await fleetAt("pending");
    expect((await editConfig(fleet, "warn_cost_usd", "3.5", registry)).ok).toBe(true);
    expect(fleet.spec.config.warn_cost_usd).toBe(3.5);
    expect((await editConfig(fleet, "effort", "low", registry)).ok).toBe(true);
    expect(fleet.spec.config.effort).toBe("low");
    expect((await editConfig(fleet, "model", "gpt-5.4", registry)).ok).toBe(true);
    expect(fleet.spec.config.model).toBe("openai/gpt-5.4");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/edits.test.ts`
Expected: FAIL — `Cannot find module '../src/edits.js'`

- [ ] **Step 3: Implement**

`src/edits.ts` (complete file):

```typescript
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveFleet } from "./controller.js";
import { resolveModelReference, type ModelRegistryLike } from "./model-resolution.js";
import { buildWorkerPrompt } from "./prompts.js";
import { THINKING_LEVELS } from "./types.js";
import type { ThinkingLevelName } from "./types.js";

export type NodeEditKey = "model" | "effort" | "task";
export type ConfigEditKey = "max_concurrent" | "warn_cost_usd" | "model" | "effort";

export interface EditResult {
  ok: boolean;
  message: string;
}

async function persistSpec(fleet: ActiveFleet): Promise<void> {
  await writeFile(join(fleet.fleetRoot, "fleet.json"), `${JSON.stringify(fleet.spec, null, 2)}\n`, "utf-8");
}

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
  if (node.status !== "pending" && node.status !== "ready") {
    return { ok: false, message: `node "${nodeId}" is ${node.status}; only pending nodes can be edited` };
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
        await writeFile(promptPath, prompt, "utf-8");
      } catch {
        // prompt.md not written yet — nothing to regenerate
      }
      break;
    }
    default:
      return { ok: false, message: `unknown node edit key "${String(key)}" (keys: model, effort, task)` };
  }
  await persistSpec(fleet);
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
      return { ok: false, message: `unknown config key "${String(key)}" (keys: max_concurrent, warn_cost_usd, model, effort)` };
  }
  await persistSpec(fleet);
  return { ok: true, message: `config.${key} updated` };
}
```

`src/command.ts` — add before the final usage fallback (imports: `editConfig`, `editNode`, `ConfigEditKey`, `NodeEditKey` from `./edits.js`):

```typescript
if (cmd === "edit") {
  const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
  const target = parts[1];
  const key = parts[2];
  let value = parts.slice(3).join(" ");
  if (!target || !key) {
    ctx.ui.notify("usage: /fleet edit <node_id> model|effort <value> | /fleet edit <node_id> task [text] | /fleet edit config <key> <value>", "warning");
    return;
  }
  await currentState(active);
  if (target === "config") {
    if (!value) {
      ctx.ui.notify("usage: /fleet edit config max_concurrent|warn_cost_usd|model|effort <value>", "warning");
      return;
    }
    const r = await editConfig(active, key as ConfigEditKey, value, ctx.modelRegistry);
    ctx.ui.notify(r.message, r.ok ? "info" : "error");
    if (r.ok) updateWidget(ctx, active);
    return;
  }
  if (key === "task" && !value) {
    const current = active.spec.workers.find((w) => w.id === target)?.task ?? "";
    const edited = await ctx.ui.editor(`task for ${target}:`, current);
    if (edited === undefined) {
      ctx.ui.notify("edit cancelled", "warning");
      return;
    }
    value = edited;
  }
  if (!value) {
    ctx.ui.notify("usage: /fleet edit <node_id> model|effort <value> | /fleet edit <node_id> task [text]", "warning");
    return;
  }
  const r = await editNode(active, target, key as NodeEditKey, value, ctx.modelRegistry);
  ctx.ui.notify(r.message, r.ok ? "info" : "error");
  if (r.ok) updateWidget(ctx, active);
  return;
}
```

`src/tools.ts` — register a new tool (imports: `editConfig`, `editNode`, `ConfigEditKey`, `NodeEditKey` from `./edits.js`):

```typescript
pi.registerTool({
  name: "fleet_edit",
  label: "Fleet Edit",
  description: "Edit the active fleet: a pending node's model, effort, or task — or fleet config (max_concurrent, warn_cost_usd, model, effort) when node_id is omitted. Changes persist to fleet.json and apply to nodes not yet dispatched. Refuses edits to nodes already running or terminal.",
  promptSnippet: "Edit a pending fleet node or fleet config.",
  parameters: Type.Object({
    node_id: Type.Optional(Type.String({ description: "Worker id to edit; omit for fleet config edits" })),
    key: Type.String({ description: "Node keys: model, effort, task. Config keys: max_concurrent, warn_cost_usd, model, effort" }),
    value: Type.String({ description: "New value" }),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const active = activeFleet.current;
    if (!active) return textResult("no fleet planned yet");
    await currentState(active);
    const r = params.node_id
      ? await editNode(active, params.node_id, params.key as NodeEditKey, params.value, ctx.modelRegistry)
      : await editConfig(active, params.key as ConfigEditKey, params.value, ctx.modelRegistry);
    if (r.ok) updateWidget(ctx, active);
    return textResult(r.message);
  },
});
```

Update the `/fleet` command description and final usage string to include `/fleet edit ...`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/edits.ts src/command.ts src/tools.ts test/edits.test.ts
git commit -m "feat: /fleet edit and fleet_edit tool for pending nodes and fleet config"
```

---

### Task 4: `fleet_design` planner tool

**Files:**
- Create: `src/planner.ts`
- Modify: `src/tools.ts` (`fleet_design` tool)
- Test: `test/planner.test.ts`

**Interfaces:**
- Produces: `slugifyFleetName(requirements: string): string`; `buildPlannerPrompt(opts: { requirements: string; fleetName: string; plannerDir: string }): string`; `runFleetDesign(opts: { requirements: string; fleetName: string; designRoot: string; repoCwd: string; sessionFactory?: SessionFactory; onEvent?: (e: WorkerEvent) => void }): Promise<FleetDesignResult>` where `FleetDesignResult = { ok: boolean; error?: string; draft?: unknown; rationale?: string; turns: number; tokens: number }`.
- Consumes: `runWorker` (runner), `validateFleetSpec`/`topoLayers` (dag), `renderDag` (viz), `ensureFleetGitignore` (fleet-store).

- [ ] **Step 1: Write the failing tests**

`test/planner.test.ts`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlannerPrompt, runFleetDesign, slugifyFleetName } from "../src/planner.js";

describe("slugifyFleetName", () => {
  it("slugifies requirements", () => {
    expect(slugifyFleetName("Research the EV Market!")).toBe("research-the-ev-market");
    expect(slugifyFleetName("---")).toBe("fleet");
    expect(slugifyFleetName("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("buildPlannerPrompt", () => {
  it("embeds requirements, paths, and the verdict contract", () => {
    const p = buildPlannerPrompt({ requirements: "build a thing", fleetName: "thing", plannerDir: "/d/planner" });
    expect(p).toContain("build a thing");
    expect(p).toContain('"fleet_name": "thing"' );
    expect(p).toContain("/d/planner/output/fleet.json");
    expect(p).toContain("verdict: lgtm");
    expect(p).toContain("Do NOT set \"model\" or \"effort\" fields");
  });
});

describe("runFleetDesign", () => {
  async function designRoot(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), "fleet-design-")), "design");
  }

  const goodFleet = {
    fleet_name: "t", type: "dag",
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };

  it("returns the parsed draft when the planner writes fleet.json", async () => {
    const root = await designRoot();
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: root, repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {
          await writeFile(join(root, "planner", "output", "fleet.json"), JSON.stringify(goodFleet), "utf-8");
          await writeFile(join(root, "planner", "output", "rationale.md"), "# Why\nbecause", "utf-8");
        },
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(true);
    expect((r.draft as { fleet_name: string }).fleet_name).toBe("t");
    expect(r.rationale).toContain("because");
  });

  it("errors when the planner writes no fleet.json", async () => {
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: await designRoot(), repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {},
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fleet.json");
  });

  it("errors when fleet.json is invalid JSON", async () => {
    const root = await designRoot();
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: root, repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {
          await writeFile(join(root, "planner", "output", "fleet.json"), "{nope", "utf-8");
        },
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
  });

  it("contains planner session failures", async () => {
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: await designRoot(), repoCwd: "/tmp",
      sessionFactory: async () => {
        throw new Error("no model");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no model");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/planner.test.ts`
Expected: FAIL — `Cannot find module '../src/planner.js'`

- [ ] **Step 3: Implement**

`src/planner.ts` (complete file):

```typescript
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runWorker, type SessionFactory, type WorkerEvent } from "./runner.js";

export const PLANNER_WORKER_ID = "planner";

export interface FleetDesignResult {
  ok: boolean;
  error?: string;
  draft?: unknown;
  rationale?: string;
  turns: number;
  tokens: number;
}

export function slugifyFleetName(requirements: string): string {
  const slug = requirements
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "fleet";
}

export function buildPlannerPrompt(opts: { requirements: string; fleetName: string; plannerDir: string }): string {
  const { requirements, fleetName, plannerDir } = opts;
  return `# Fleet designer

You design a DAG-of-agents "fleet" for the pi fleet runner. You produce ONE definition file plus a rationale.

## Requirements from the user

${requirements}

## Your outputs (both REQUIRED)

- ${plannerDir}/output/fleet.json — the fleet definition. A single raw JSON object, no markdown fences, no commentary.
- ${plannerDir}/output/rationale.md — why this decomposition, what each node does, why the gate choice.

## Fleet JSON schema

{
  "fleet_name": "${fleetName}",
  "type": "dag",
  "config": {
    "max_concurrent": <integer >= 1, optional>,
    "warn_cost_usd": <number >= 0, optional>,
    "loop": { "gate": "reviewer" | "none", "max_iterations": <int >= 1>, "lgtm_count": <optional int, reviewer gate only> }
  },
  "workers": [
    {
      "id": "kebab-case",
      "type": "research" | "code-run" | "reviewer" | "write" | "read-only",
      "task": "full self-contained instructions for the worker",
      "depends_on": ["upstream-worker-ids"],
      "outputs": [{ "path": "output/<file> or repo-relative path", "kind": "markdown" | "file-exists" | "verdict" | "json" | "yaml", "required": true }],
      "iterate": true,
      "worktree": false
    }
  ]
}

config, outputs, iterate, worktree, and loop are optional (defaults: max_concurrent 4, iterate true, worktree false).

## Hard rules (violations fail validation)

1. fleet_name and worker ids are kebab-case; ids unique.
2. depends_on references existing workers only; the graph must be acyclic.
3. Do NOT set "model" or "effort" fields anywhere — the runner assigns models and effort.
4. With gate "reviewer": exactly one worker declares an output of kind "verdict"; that worker must be a sink (nothing depends on it) and must iterate. Its task must instruct: the review file starts with exactly one of \`verdict: lgtm\` / \`verdict: iterate\` / \`verdict: escalate\`, followed by specific actionable per-worker feedback.
5. With gate "none": at least one worker must have iterate enabled (default true counts).
6. A worker with iterate: false may not depend on a worker that iterates.
7. Output paths: "output/..." resolves under the worker dir (use for notes, reports, verdicts); any other relative path is repo-relative (use for code edits). No absolute paths, no "..".
8. Worker types and tools: research (read/web/write), code-run (full coding tools), reviewer (read/write), write (read/write), read-only (read only).

## Design guidance

- Decompose into independent layer-0 research/analysis nodes that run in parallel, then synthesis/writer nodes, then optionally a reviewer gate.
- Prefer few high-value nodes over many trivial ones; 3-10 workers is typical.
- Each task must be self-contained: what to produce, where, format, constraints, done-criteria.
- Use a loop with gate "reviewer" only when iterative refinement against feedback makes sense; otherwise a single pass is cheaper.
`;
}

export async function runFleetDesign(opts: {
  requirements: string;
  fleetName: string;
  designRoot: string;
  repoCwd: string;
  sessionFactory?: SessionFactory;
  onEvent?: (e: WorkerEvent) => void;
}): Promise<FleetDesignResult> {
  const plannerDir = join(opts.designRoot, "planner");
  await mkdir(join(plannerDir, "output"), { recursive: true });
  const prompt = buildPlannerPrompt({ requirements: opts.requirements, fleetName: opts.fleetName, plannerDir });
  const res = await runWorker({
    nodeId: PLANNER_WORKER_ID,
    worker: { id: PLANNER_WORKER_ID, type: "write", task: "design a fleet DAG", depends_on: [], outputs: [] },
    prompt,
    repoCwd: opts.repoCwd,
    sessionDir: plannerDir,
    sessionFactory: opts.sessionFactory,
    thinkingLevel: "medium",
    onEvent: opts.onEvent ?? (() => {}),
  });
  if (!res.ok) {
    return { ok: false, error: res.error ?? "planner session failed", turns: res.turns, tokens: res.tokens };
  }
  let raw: string;
  try {
    raw = await readFile(join(plannerDir, "output", "fleet.json"), "utf-8");
  } catch {
    return { ok: false, error: "planner did not write output/fleet.json", turns: res.turns, tokens: res.tokens };
  }
  let draft: unknown;
  try {
    draft = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `fleet.json is not valid JSON: ${(e as Error).message}`, turns: res.turns, tokens: res.tokens };
  }
  let rationale: string | undefined;
  try {
    rationale = await readFile(join(plannerDir, "output", "rationale.md"), "utf-8");
  } catch {
    // rationale is optional in the result
  }
  return { ok: true, draft, rationale, turns: res.turns, tokens: res.tokens };
}
```

`src/tools.ts` — register the tool (imports: `runFleetDesign`, `slugifyFleetName` from `./planner.js`; `renderDag` already imported; `ensureFleetGitignore` already imported):

```typescript
pi.registerTool({
  name: "fleet_design",
  label: "Fleet Design",
  description: "Draft a fleet DAG from plain-language requirements. Spawns a planner agent that writes a fleet.json definition, validates it, and returns an ASCII preview with the JSON. Does NOT plan or launch anything. Use this before fleet_plan whenever requirements are prose rather than a ready fleet definition.",
  promptSnippet: "Draft a fleet DAG from plain-language requirements.",
  parameters: Type.Object({
    requirements: Type.String({ description: "Plain-language description of the goal" }),
    fleet_name: Type.Optional(Type.String({ description: "kebab-case; derived from requirements when omitted" })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const fleetName = params.fleet_name ?? slugifyFleetName(params.requirements);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(fleetName)) {
      return textResult(`fleet_name "${fleetName}" must be kebab-case`);
    }
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const designRoot = join(ctx.cwd, ".fleet", `design-${fleetName}-${ts}`);
    await ensureFleetGitignore(ctx.cwd);
    const result = await runFleetDesign({
      requirements: params.requirements,
      fleetName,
      designRoot,
      repoCwd: ctx.cwd,
    });
    if (!result.ok) return textResult(`fleet design failed: ${result.error}`);
    const v = validateFleetSpec(result.draft);
    if (!v.ok) {
      return textResult(
        `planner produced an invalid fleet:\n${v.errors.join("\n")}\n\ndraft JSON:\n${JSON.stringify(result.draft, null, 2)}\n\nFix the JSON and call fleet_plan directly, or retry fleet_design with clearer requirements.`,
      );
    }
    const dag = renderDag(v.spec);
    return textResult(
      `${dag}\n\nrationale: ${join(designRoot, "planner", "output", "rationale.md")}\n\nfleet JSON:\n${JSON.stringify(result.draft, null, 2)}\n\nShow this preview to the user. If they approve, call fleet_plan with this definition (fleet_launch only after their explicit confirmation).`,
      { designRoot },
    );
  },
});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/planner.ts src/tools.ts test/planner.test.ts
git commit -m "feat: fleet_design planner tool drafts fleet DAGs from requirements"
```

---

## Self-Review Notes

- Spec coverage: #4 → Task 1; #8 → Task 2; #10 → Task 3; #7 → Task 4. ✅
- Placeholder scan: all code steps complete. ✅
- Type consistency: `FleetPreferences`, `NodeEditKey`/`ConfigEditKey`, `FleetDesignResult`, `THINKING_LEVELS`, `nodeKills`, `onSession`, `sessions`/`killedNodes` used consistently. ✅
- Task 2's controller test constructs `ActiveFleet` — must include `sessions`/`killedNodes` (Task 2 adds them to the interface; the existing `runningFleet()` helper in `test/controller.test.ts` must gain both fields).
- Task 3 depends on Task 2's `ActiveFleet` shape (its `fleetAt` helper includes `sessions`/`killedNodes`). Order fixed 1→4.
