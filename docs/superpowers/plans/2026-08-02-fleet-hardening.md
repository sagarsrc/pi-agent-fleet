# Fleet Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/index.ts` into focused modules, then fix effort control, launch-confirm flow, widget quality, model bias, and model-unavailability resilience (todo.md #1, #2, #3, #9, #12, #13, #14).

**Architecture:** Extract `index.ts` internals into `model-resolution.ts`, `fleet-store.ts`, `controller.ts`, `tools.ts`, `command.ts`; move session-factory helpers into `runner.ts`. Then layered bugfixes on the extracted modules.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, pi extension API (`@earendil-works/pi-coding-agent`), typebox.

**Worktree root (all paths resolve here):** `/Users/sagar/work/pi-fleet-extension/.worktrees/fleet-hardening`

## Global Constraints

- All imports of local modules use the `.js` suffix (NodeNext ESM).
- `npm test` AND `npm run typecheck` must be green at the end of every task.
- No new runtime or dev dependencies.
- Commit style: conventional (`refactor:`, `feat:`, `fix:`, `test:`). One commit per task unless noted.
- `FleetConfig.model` becomes OPTIONAL (`model?: string`) — no `"gpt-5.4"` default anywhere. Resolution order: `worker.model` → `config.model` → pi session default.
- Effort type: `ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Resolution order: `worker.effort` → `config.effort` → `"medium"`.
- Widget header must say `lgtm streak` (not bare `streak`). Widget line budget default: `maxLines = 12`.
- `fleet_plan` result text must end with: `Show this preview to the user. Call fleet_launch only after they explicitly confirm.`
- Existing tests may only be modified where behavior intentionally changes (Task 3 model default, Task 5 widget lines). Refactor Task 1 changes no existing test files.

---

### Task 1: Module split (pure refactor, no behavior change)

**Files:**
- Create: `src/model-resolution.ts`
- Create: `src/fleet-store.ts`
- Create: `src/controller.ts`
- Create: `src/tools.ts`
- Create: `src/command.ts`
- Modify: `src/runner.ts` (add `sessionFactoryForModel`, `workerWithResolvedModel`)
- Rewrite: `src/index.ts` (thin wiring)
- Test: `test/model-resolution.test.ts`, `test/fleet-store.test.ts`

**Interfaces:**
- Produces:
  - `model-resolution.ts`: `aliasesFor(model: Model<Api>): string[]`, `type ModelRegistryLike = { getAvailable(): Model<Api>[]; getAll(): Model<Api>[] }`, `resolveModelReference(registry: ModelRegistryLike, ref: string): { ok: true; model: Model<Api> } | { ok: false; error: string }`
  - `fleet-store.ts`: `fleetRootFor(cwd: string, name: string): string`, `isInsideGitRepo(cwd: string): Promise<boolean>`, `ensureFleetGitignore(cwd: string): Promise<void>`, `writePlanFiles(fleetRoot: string, spec: FleetSpec, state: FleetState): Promise<void>`, `writeWorkerPrompts(fleet: { spec: FleetSpec; state: FleetState; fleetRoot: string }): Promise<void>`
  - `controller.ts`: `interface ActiveFleet`, `interface ActiveFleetCell { current: ActiveFleet | undefined }`, `const activeFleet: ActiveFleetCell`, `updateWidget(ctx: ExtensionContext, fleet: ActiveFleet): void`, `currentState(fleet: ActiveFleet): Promise<FleetState>`, `statusText(fleet: ActiveFleet): Promise<string>`, `dagPreview(spec: FleetSpec, state: FleetState | undefined, fleetRoot: string): Promise<string>`, `startLoop(fleet: ActiveFleet, ctx: ExtensionContext, resume?: boolean, continuePass?: boolean): Promise<void>`, `killFleet(target: string): Promise<string>`
  - `tools.ts`: `registerFleetTools(pi: ExtensionAPI): void`, `textResult(text: string, details?: Record<string, unknown>)`
  - `command.ts`: `registerFleetCommand(pi: ExtensionAPI): void`
  - `runner.ts` adds: `sessionFactoryForModel(model: Model<Api>): SessionFactory`, `workerWithResolvedModel(worker: WorkerSpec, model: Model<Api> | undefined): WorkerSpec`
- Consumes: existing `dag.ts`, `state.ts`, `scheduler.ts`, `runner.ts`, `report.ts`, `prompts.ts`, `ui.ts`, `viz.ts`, `types.ts` — unchanged.

- [ ] **Step 1: Write the failing tests**

`test/model-resolution.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { aliasesFor, resolveModelReference, type ModelRegistryLike } from "../src/model-resolution.js";

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
```

`test/fleet-store.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureFleetGitignore, fleetRootFor, isInsideGitRepo, writePlanFiles } from "../src/fleet-store.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t",
  type: "dag",
  config: { max_concurrent: 2, model: "m" },
  workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
};

describe("fleetRootFor", () => {
  it("joins cwd/.fleet/name-timestamp", () => {
    const r = fleetRootFor("/repo", "my-fleet");
    expect(r.startsWith("/repo/.fleet/my-fleet-")).toBe(true);
  });
});

describe("isInsideGitRepo", () => {
  it("true when an ancestor has .git, false otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-store-"));
    expect(await isInsideGitRepo(dir)).toBe(false);
    await mkdir(join(dir, ".git"));
    expect(await isInsideGitRepo(join(dir, "sub", "deep"))).toBe(true);
  });
});

describe("ensureFleetGitignore", () => {
  it("creates gitignore with * and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-store-"));
    await ensureFleetGitignore(dir);
    const p = join(dir, ".fleet", ".gitignore");
    expect((await readFile(p, "utf-8")).trim()).toBe("*");
    await ensureFleetGitignore(dir);
    expect((await readFile(p, "utf-8")).trim()).toBe("*");
  });

  it("preserves existing content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-store-"));
    await mkdir(join(dir, ".fleet"), { recursive: true });
    const p = join(dir, ".fleet", ".gitignore");
    await writeFile(p, "keep-me\n", "utf-8");
    await ensureFleetGitignore(dir);
    const c = await readFile(p, "utf-8");
    expect(c).toContain("keep-me");
    expect(c).toContain("*");
  });
});

describe("writePlanFiles", () => {
  it("writes fleet.json, state.json, and worker output dirs", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "fleet-store-")), "fr");
    await writePlanFiles(root, spec, initFleetState(spec));
    const fleet = JSON.parse(await readFile(join(root, "fleet.json"), "utf-8"));
    expect(fleet.fleet_name).toBe("t");
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf-8"));
    expect(state.nodes.a.status).toBe("pending");
    const out = await stat(join(root, "workers", "a", "output"));
    expect(out.isDirectory()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/model-resolution.test.ts test/fleet-store.test.ts`
Expected: FAIL — `Cannot find module '../src/model-resolution.js'` / `'../src/fleet-store.js'`

- [ ] **Step 3: Create the modules (move code from index.ts)**

`src/model-resolution.ts`:

```typescript
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
```

`src/fleet-store.ts`:

```typescript
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildWorkerPrompt } from "./prompts.js";
import { writeState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";

export function fleetRootFor(cwd: string, name: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return join(cwd, ".fleet", `${name}-${ts}`);
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  let dir = cwd;
  while (true) {
    try {
      const s = await stat(join(dir, ".git"));
      if (s.isFile() || s.isDirectory()) return true;
    } catch {
      // any stat failure (ENOENT, EACCES, etc.) is treated as not-found
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export async function ensureFleetGitignore(cwd: string): Promise<void> {
  const dir = join(cwd, ".fleet");
  const gitignore = join(dir, ".gitignore");
  await mkdir(dir, { recursive: true });
  let current = "";
  try {
    current = await readFile(gitignore, "utf-8");
  } catch {
    // created below
  }
  if (!current.split(/\r?\n/).includes("*")) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await writeFile(gitignore, `${current}${prefix}*\n`, "utf-8");
  }
}

export async function writePlanFiles(fleetRoot: string, spec: FleetSpec, state: FleetState): Promise<void> {
  await mkdir(fleetRoot, { recursive: true });
  await Promise.all(spec.workers.map((w) => mkdir(join(fleetRoot, "workers", w.id, "output"), { recursive: true })));
  await writeFile(join(fleetRoot, "fleet.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
  await writeState(fleetRoot, state);
}

export async function writeWorkerPrompts(fleet: { spec: FleetSpec; state: FleetState; fleetRoot: string }): Promise<void> {
  await Promise.all(fleet.spec.workers.map(async (w) => {
    const prompt = buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: w.id, fleetRoot: fleet.fleetRoot });
    await writeFile(join(fleet.fleetRoot, "workers", w.id, "prompt.md"), prompt, "utf-8");
  }));
}
```

Add to bottom of `src/runner.ts` (plus `import type { Api, Model } from "@earendil-works/pi-ai";` at top):

```typescript
export function sessionFactoryForModel(model: Model<Api>): SessionFactory {
  return async (opts) => {
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      tools: opts.tools,
      sessionManager: SessionManager.create(opts.cwd, opts.sessionDir),
      model,
    });
    return session as unknown as AgentSessionLike;
  };
}

export function workerWithResolvedModel(worker: WorkerSpec, model: Model<Api> | undefined): WorkerSpec {
  return model ? { ...worker, model: `${model.provider}/${model.id}` } : worker;
}
```

`src/controller.ts` (move from index.ts; `active` module variable becomes an exported cell):

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { writeWorkerPrompts } from "./fleet-store.js";
import { resolveModelReference } from "./model-resolution.js";
import { writeReport } from "./report.js";
import { runWorker, sessionFactoryForModel, workerWithResolvedModel } from "./runner.js";
import { runFleet } from "./scheduler.js";
import { patchNode, readState, writeState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";
import { buildWidgetLines } from "./ui.js";
import { dagNeedsFileFallback, renderDag } from "./viz.js";

export interface ActiveFleet {
  spec: FleetSpec;
  fleetRoot: string;
  state: FleetState;
  killSwitch: { killed: boolean };
  pauseSwitch: { paused: boolean };
  running: boolean;
  costWarned?: boolean;
}

export interface ActiveFleetCell {
  current: ActiveFleet | undefined;
}

export const activeFleet: ActiveFleetCell = { current: undefined };

export function updateWidget(ctx: ExtensionContext, fleet: ActiveFleet): void {
  if (ctx.hasUI) ctx.ui.setWidget("fleet", buildWidgetLines(fleet.spec, fleet.state));
}

export async function currentState(fleet: ActiveFleet): Promise<FleetState> {
  if (fleet.running) return fleet.state;
  try {
    fleet.state = await readState(fleet.fleetRoot);
  } catch {
    // keep in-memory state
  }
  return fleet.state;
}

export async function statusText(fleet: ActiveFleet): Promise<string> {
  const state = await currentState(fleet);
  return renderDag(fleet.spec, state);
}

export async function dagPreview(spec: FleetSpec, state: FleetState | undefined, fleetRoot: string): Promise<string> {
  const out = renderDag(spec, state);
  const width = process.stdout.columns ?? 120;
  if (dagNeedsFileFallback(spec, width)) {
    const p = join(fleetRoot, "dag.txt");
    await writeFile(p, out, "utf-8");
    return `${out}\n\nDAG preview saved: ${p}`;
  }
  return out;
}

export async function startLoop(fleet: ActiveFleet, ctx: ExtensionContext, resume = false, continuePass = false): Promise<void> {
  fleet.running = true;
  fleet.costWarned = false;
  updateWidget(ctx, fleet);

  const checkCostWarning = () => {
    const warn = fleet.spec.config.warn_cost_usd;
    if (!warn || fleet.costWarned) return;
    const cost = fleet.state.cost_usd_estimate;
    if (cost >= warn) {
      fleet.costWarned = true;
      if (ctx.hasUI) ctx.ui.notify(`fleet cost warning: $${cost.toFixed(4)} >= $${warn}`, "warning");
    }
  };

  const spawn = async (nodeId: string) => {
    try {
      const worker = fleet.spec.workers.find((w) => w.id === nodeId);
      if (!worker) return { ok: false, turns: 0, tokens: 0, error: `unknown worker "${nodeId}"` };

      let resolvedModel: Model<Api> | undefined;
      let modelNote: string | undefined;
      if (worker.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, worker.model);
        if (!resolved.ok) return { ok: false, turns: 0, tokens: 0, error: resolved.error };
        resolvedModel = resolved.model;
      } else if (fleet.spec.config.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, fleet.spec.config.model);
        if (resolved.ok) resolvedModel = resolved.model;
        else modelNote = `config.model "${fleet.spec.config.model}" not found, using session default`;
      }
      if (modelNote) {
        fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: modelNote });
        updateWidget(ctx, fleet);
      }

      const prompt = await readFile(join(fleet.fleetRoot, "workers", nodeId, "prompt.md"), "utf-8");
      const sessionDir = join(fleet.fleetRoot, "workers", nodeId);
      return await runWorker({
        nodeId,
        worker: workerWithResolvedModel(worker, resolvedModel),
        prompt,
        repoCwd: ctx.cwd,
        sessionDir,
        sessionFactory: resolvedModel ? sessionFactoryForModel(resolvedModel) : undefined,
        onEvent: (e) => {
          if (e.type === "turn") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { turns: e.turns });
          if (e.type === "tokens") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { tokens: e.tokens });
          if (e.type === "cost") {
            fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { cost_usd_estimate: e.cost });
            checkCostWarning();
          }
          if (e.type === "error") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: e.message });
          updateWidget(ctx, fleet);
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, turns: 0, tokens: 0, error };
    }
  };

  let resumeFrom: FleetState | undefined;
  if (continuePass) {
    resumeFrom = fleet.state;
  } else if (resume) {
    resumeFrom = await readState(fleet.fleetRoot);
  }

  try {
    const state = await runFleet({
      spec: fleet.spec,
      fleetRoot: fleet.fleetRoot,
      repoCwd: (nodeId) => {
        const worker = fleet.spec.workers.find((w) => w.id === nodeId);
        return worker?.worktree ? join(fleet.fleetRoot, "worktrees", nodeId) : ctx.cwd;
      },
      spawn,
      killSwitch: fleet.killSwitch,
      pauseSwitch: fleet.pauseSwitch,
      onNodeChange: (nodeId, nodeState) => {
        fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, nodeState);
        checkCostWarning();
        updateWidget(ctx, fleet);
      },
      prepareIteration: async (_n, state) => {
        fleet.state = state;
        await writeWorkerPrompts(fleet);
      },
      resumeFrom,
      continuePass,
    });
    fleet.state = state;
    fleet.running = false;
    if (ctx.hasUI) ctx.ui.setWidget("fleet", []);
    const report = await writeReport({ spec: fleet.spec, state, fleetRoot: fleet.fleetRoot, repoCwd: ctx.cwd });
    const last = state.iterations[state.iterations.length - 1];
    if (state.status === "paused" && last?.verdict === "escalate") {
      if (ctx.hasUI) ctx.ui.notify(`fleet paused: reviewer escalated; report: ${join(fleet.fleetRoot, "report.md")}`, "warning");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`fleet ${state.status}; report: ${join(fleet.fleetRoot, "report.md")}`, state.status === "completed" ? "info" : "warning");
    }
  } catch (err: unknown) {
    fleet.running = false;
    if (ctx.hasUI) ctx.ui.setWidget("fleet", []);
    const error = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`fleet failed: ${error}`, "error");
  }
}

export async function killFleet(target: string): Promise<string> {
  const active = activeFleet.current;
  if (!active) return "no fleet planned yet";
  if (target !== "all") return "single-node kill not supported in v1 — use target \"all\"";
  active.killSwitch.killed = true;
  return "fleet kill requested";
}
```

`src/tools.ts`: move `textResult`, all four Typebox schemas (`OutputSchema`, `WorkerSchema`, `FleetSchema` — keep them module-private inside `registerFleetTools` exactly as in current index.ts), and all seven `pi.registerTool` calls. New file skeleton:

```typescript
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateFleetSpec } from "./dag.js";
import { activeFleet, currentState, dagPreview, killFleet, startLoop, statusText, updateWidget } from "./controller.js";
import { ensureFleetGitignore, fleetRootFor, isInsideGitRepo, writePlanFiles, writeWorkerPrompts } from "./fleet-store.js";
import { resolveModelReference } from "./model-resolution.js";
import { writeReport } from "./report.js";
import { initFleetState, resetForRelaunch, writeState } from "./state.js";
import { buildWidgetLines } from "./ui.js";
import { renderDag } from "./viz.js";

export function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function registerFleetTools(pi: ExtensionAPI): void {
  // ... OutputSchema, WorkerSchema, FleetSchema definitions copied verbatim from index.ts ...
  // ... the seven pi.registerTool blocks copied verbatim from index.ts,
  //     with every reference to the old module-level `active` replaced by `activeFleet.current`,
  //     and `active = {...}` in fleet_plan replaced by `activeFleet.current = {...}` ...
}
```

`src/command.ts`: move the entire `pi.registerCommand("fleet", ...)` block, wrapped as:

```typescript
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeFleet, currentState, killFleet, startLoop, updateWidget } from "./controller.js";
import { resolveModelReference } from "./model-resolution.js";
import { resetForRelaunch, writeState } from "./state.js";
import { buildWidgetLines } from "./ui.js";
import { renderDag } from "./viz.js";

export function registerFleetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("fleet", {
    description: "Fleet commands: /fleet viz, /fleet status, /fleet clear, /fleet kill all, /fleet pause, /fleet resume, /fleet relaunch <node_id> [model]",
    handler: async (args, ctx) => {
      const active = activeFleet.current;
      // ... rest of handler copied verbatim from index.ts ...
    },
  });
}
```

New `src/index.ts` (complete file):

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFleetCommand } from "./command.js";
import { activeFleet } from "./controller.js";
import { registerFleetTools } from "./tools.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    activeFleet.current = undefined;
    ctx.ui.setStatus("fleet", "");
  });
  registerFleetTools(pi);
  registerFleetCommand(pi);
}
```

- [ ] **Step 4: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: 113+ tests pass (111 existing + 2 new files' tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ test/model-resolution.test.ts test/fleet-store.test.ts
git commit -m "refactor: split index.ts into model-resolution, fleet-store, controller, tools, command modules"
```

---

### Task 2: Effort (thinking level) support

**Files:**
- Modify: `src/types.ts`
- Modify: `src/dag.ts`
- Modify: `src/runner.ts`
- Modify: `src/controller.ts`
- Modify: `src/tools.ts`
- Test: `test/dag.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Produces: `types.ts`: `type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; `WorkerSpec.effort?: ThinkingLevelName`; `FleetConfig.effort?: ThinkingLevelName`. `runner.ts`: `SessionOpts.thinkingLevel?: ThinkingLevelName`; `RunWorkerOpts.thinkingLevel?: ThinkingLevelName`.
- Consumes: Task 1 modules unchanged in shape.

- [ ] **Step 1: Write the failing tests**

Append to `test/dag.test.ts` (imports already exist there: `validateFleetSpec`):

```typescript
describe("effort validation", () => {
  it("accepts config.effort and worker effort", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      config: { effort: "high" },
      workers: [{ id: "a", type: "research", task: "t", effort: "low" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.config.effort).toBe("high");
      expect(r.spec.workers[0].effort).toBe("low");
    }
  });

  it("rejects bad config.effort", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      config: { effort: "ludicrous" },
      workers: [{ id: "a", type: "research", task: "t" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("config.effort");
  });

  it("rejects bad worker effort", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      workers: [{ id: "a", type: "research", task: "t", effort: "maxed" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain('worker "a": bad effort');
  });
});
```

Append to `test/runner.test.ts` (match the existing fake-session style in that file):

```typescript
it("forwards thinkingLevel to the session factory", async () => {
  let seen: string | undefined;
  await runWorker({
    nodeId: "a",
    worker: { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    prompt: "p",
    repoCwd: "/tmp",
    thinkingLevel: "high",
    sessionFactory: async (opts) => {
      seen = opts.thinkingLevel;
      return {
        prompt: async () => {},
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      };
    },
    onEvent: () => {},
  });
  expect(seen).toBe("high");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dag.test.ts test/runner.test.ts`
Expected: FAIL — `thinkingLevel` not in `RunWorkerOpts` type / effort not validated (TS errors surface as test failures; if vitest reports type errors, that is the expected red).

- [ ] **Step 3: Implement**

`src/types.ts` — add after the `GateKind`/`Verdict` block:

```typescript
export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

Add to `WorkerSpec`: `effort?: ThinkingLevelName;` (after `model?: string;`).
Add to `FleetConfig`: `effort?: ThinkingLevelName;` (after `model: string;` — note: Task 3 makes `model` optional; if Task 3 already landed, add after `model?: string;`).

`src/dag.ts` — add near the other constants:

```typescript
const EFFORTS: ThinkingLevelName[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
```

Import `ThinkingLevelName` in the type import line. In `validateFleetSpec`, after the `model` line:

```typescript
const effort = typeof cfg.effort === "string" ? cfg.effort as ThinkingLevelName : undefined;
if (effort !== undefined && !EFFORTS.includes(effort)) {
  errors.push(`config.effort must be one of ${EFFORTS.join(", ")}`);
}
```

In the worker loop, after the `model` handling:

```typescript
const wEffort = typeof w.effort === "string" ? w.effort as ThinkingLevelName : undefined;
if (wEffort !== undefined && !EFFORTS.includes(wEffort)) {
  errors.push(`worker "${id}": bad effort "${String(w.effort)}"`);
}
```

Add `effort: wEffort,` to the pushed worker object, and `effort,` to `spec.config`.

`src/runner.ts`:

```typescript
// type import line gains CreateAgentSessionOptions:
import { createAgentSession, SessionManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelName } from "./types.js";

type ThinkingLevelOption = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
```

- `SessionOpts` gains `thinkingLevel?: ThinkingLevelName;`
- `RunWorkerOpts` gains `thinkingLevel?: ThinkingLevelName;`
- `defaultSessionFactory` passes `thinkingLevel: opts.thinkingLevel as ThinkingLevelOption,` into `createAgentSession`.
- `sessionFactoryForModel` passes the same line into its `createAgentSession` call.
- `runWorker` factory call becomes:

```typescript
const session = await factory({
  cwd: opts.repoCwd,
  sessionDir: opts.sessionDir ?? opts.repoCwd,
  tools: WORKER_TYPE_TOOLS[opts.worker.type],
  model: opts.worker.model,
  thinkingLevel: opts.thinkingLevel,
});
```

`src/controller.ts` — in `startLoop`'s `spawn`, before the `runWorker` call:

```typescript
const effort = worker.effort ?? fleet.spec.config.effort ?? "medium";
```

and add `thinkingLevel: effort,` to the `runWorker({...})` argument.

`src/tools.ts` — add near `OutputSchema`:

```typescript
const EffortSchema = Type.Union([
  Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
  Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
], { description: "Thinking effort level" });
```

- `WorkerSchema` gains: `effort: Type.Optional(EffortSchema),`
- config object in `FleetSchema` gains: `effort: Type.Optional(EffortSchema),`

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/dag.ts src/runner.ts src/controller.ts src/tools.ts test/dag.test.ts test/runner.test.ts
git commit -m "feat: effort (thinking level) per fleet and per worker, default medium"
```

---

### Task 3: Remove model bias + harden launch-confirm flow

**Files:**
- Modify: `src/types.ts` (`FleetConfig.model` → optional)
- Modify: `src/dag.ts` (drop `"gpt-5.4"` default)
- Modify: `src/ui.ts`, `src/viz.ts` (label fallback)
- Modify: `src/tools.ts` (descriptions + plan result text)
- Test: `test/dag.test.ts`, `test/ui.test.ts`, `test/viz.test.ts`

**Interfaces:**
- Consumes: Task 1-2 modules.
- Produces: `FleetConfig.model?: string`. Model label fallback string is exactly `(default)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/dag.test.ts`:

```typescript
it("leaves config.model undefined when not provided", () => {
  const r = validateFleetSpec({
    fleet_name: "t", type: "dag",
    workers: [{ id: "a", type: "research", task: "t" }],
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.spec.config.model).toBeUndefined();
});
```

Append to `test/ui.test.ts`:

```typescript
it("falls back to (default) model label", () => {
  const s: FleetSpec = {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1 },
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };
  const lines = buildWidgetLines(s, initFleetState(s));
  expect(lines[1]).toContain("(default)");
});
```

Append to `test/viz.test.ts` (match its existing import style — it imports `renderDag` and builds specs):

```typescript
it("renderDag falls back to (default) model label", () => {
  const s: FleetSpec = {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1 },
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };
  expect(renderDag(s)).toContain("a (default)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dag.test.ts test/ui.test.ts test/viz.test.ts`
Expected: FAIL — `config.model` is `"gpt-5.4"`/required type error; labels show model instead of `(default)`.

- [ ] **Step 3: Implement**

`src/types.ts`: `FleetConfig` line `model: string;` → `model?: string;`.

`src/dag.ts`: replace

```typescript
const model = typeof cfg.model === "string" ? cfg.model : "gpt-5.4";
```

with

```typescript
const model = typeof cfg.model === "string" ? cfg.model : undefined;
```

`src/ui.ts`: `const model = w.model ?? spec.config.model;` → `const model = w.model ?? spec.config.model ?? "(default)";`

`src/viz.ts` `modelOf`: `return w?.model ?? spec.config.model ?? "(default)";`

`src/tools.ts` `fleet_plan` description — replace the whole description string with:

```
Validate a fleet DAG definition, create its fleet root, and return an ASCII preview. Does NOT launch. Present the preview to the user; call fleet_launch only after they explicitly confirm. Choose models by task difficulty: cheap/fast models for trivial writers and validators, mid-tier coding models for code-run workers, strongest reasoning models for reviewers and synthesizers. When several models fit a tier, vary providers across nodes instead of defaulting to one family. Set worker.model per node to override config.model. All model refs are validated against the live registry — planning fails if any model is unavailable.
```

`fleet_plan` execute — change the final return to:

```typescript
return textResult(`${dag}\n\nfleet root: ${fleetRoot}\nShow this preview to the user. Call fleet_launch only after they explicitly confirm.`, { fleetRoot, layers: v.layers });
```

`fleet_launch` description — replace with:

```
Launch the active planned fleet after the user has confirmed the plan preview. Runs the DAG in the background and updates the live fleet widget. Pass skip_confirm: true only when the user already approved this exact plan (e.g. unattended runs); otherwise the interactive confirmation is shown.
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass. If any existing test asserts the old `"gpt-5.4"` default, update that assertion to the new behavior (document the change in the commit message).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/dag.ts src/ui.ts src/viz.ts src/tools.ts test/
git commit -m "fix: drop gpt-5.4 default model, neutral model guidance, explicit launch-confirm flow"
```

---

### Task 4: Model resilience (fail fast + per-node containment)

**Files:**
- Modify: `src/model-resolution.ts` (add `validateFleetModels`)
- Modify: `src/tools.ts` (plan + launch wiring)
- Modify: `src/runner.ts` (factory try/catch)
- Test: `test/model-resolution.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Produces: `validateFleetModels(spec: FleetSpec, registry: ModelRegistryLike): { ok: true } | { ok: false; errors: string[] }` — error strings name the source: `config.model: model "x" not found` / `worker "a" model: model "y" not found`.
- Consumes: Task 1-3 modules.

- [ ] **Step 1: Write the failing tests**

Append to `test/model-resolution.test.ts` (add `import type { FleetSpec } from "../src/types.js";` and `validateFleetModels` to the import):

```typescript
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
```

Append to `test/runner.test.ts`:

```typescript
it("session factory throw becomes a per-node failure", async () => {
  const res = await runWorker({
    nodeId: "a",
    worker: { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    prompt: "p",
    repoCwd: "/tmp",
    sessionFactory: async () => {
      throw new Error("model exploded");
    },
    onEvent: () => {},
  });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("model exploded");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/model-resolution.test.ts test/runner.test.ts`
Expected: FAIL — `validateFleetModels` not exported; factory throw propagates.

- [ ] **Step 3: Implement**

`src/model-resolution.ts` — append (add `import type { FleetSpec } from "./types.js";` at top):

```typescript
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
    if (!r.ok) errors.push(`${label}: ${r.error}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
```

`src/runner.ts` — wrap the factory call in `runWorker`:

```typescript
let session: AgentSessionLike;
try {
  session = await factory({
    cwd: opts.repoCwd,
    sessionDir: opts.sessionDir ?? opts.repoCwd,
    tools: WORKER_TYPE_TOOLS[opts.worker.type],
    model: opts.worker.model,
    thinkingLevel: opts.thinkingLevel,
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  opts.onEvent({ type: "error", nodeId: opts.nodeId, message });
  return { ok: false, turns: 0, tokens: 0, cost: 0, error: message };
}
```

(The existing `let turns = 0; ...` block and the outer try/finally stay; `unsub`/`dispose` are only reached when `session` exists.)

`src/tools.ts`:

In `fleet_plan` execute, immediately after the `validateFleetSpec` guard:

```typescript
const modelCheck = validateFleetModels(v.spec, ctx.modelRegistry);
if (!modelCheck.ok) return textResult(`Invalid fleet:\n${modelCheck.errors.join("\n")}`);
```

In `fleet_launch` execute, after the `active.running` guard:

```typescript
const modelCheck = validateFleetModels(fleet.spec, ctx.modelRegistry);
if (!modelCheck.ok) {
  return textResult(`Cannot launch — unresolvable models:\n${modelCheck.errors.join("\n")}`);
}
```

Add `validateFleetModels` to the model-resolution import in tools.ts.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/model-resolution.ts src/tools.ts src/runner.ts test/model-resolution.test.ts test/runner.test.ts
git commit -m "fix: validate fleet models at plan and launch; contain session factory failures per node"
```

---

### Task 5: Widget overhaul (stats retention, truncation, spinner, lgtm streak)

**Files:**
- Modify: `src/ui.ts` (rewrite `buildWidgetLines`)
- Modify: `src/controller.ts` (spinner ticker, final widget render instead of clear)
- Test: `test/ui.test.ts`, `test/controller.test.ts`

**Interfaces:**
- Produces: `buildWidgetLines(spec: FleetSpec, state: FleetState, opts?: { maxLines?: number; spinnerFrame?: number }): string[]`; `SPINNER_FRAMES: readonly string[]`; `DEFAULT_MAX_LINES = 12`; `startSpinner(ctx: ExtensionContext, fleet: ActiveFleet, intervalMs?: number): () => void`; `updateWidget(ctx, fleet, spinnerFrame?: number)`.
- Consumes: Task 1-4 modules.

Behavior spec for `buildWidgetLines`:
- Header: unchanged except `streak` → `lgtm streak`.
- Node line: `<branch> <icon> <id> (<model>)<detail><note>`.
  - `icon`: for `running` when `spinnerFrame` provided → `SPINNER_FRAMES[spinnerFrame % 10]`; otherwise static map `completed: "✓", failed/contract_failed: "✗", running: "⠹", blocked/killed: "⊘", pending/ready: "○"`.
  - `detail`: for statuses `running`, `completed`, `failed`, `contract_failed` → ` · <turns> turns · <tokens/1000, 1dp>k tok · $<cost, 2dp>`. Other statuses → no detail.
  - `note`: ` · <status_note>` when present.
- Line budget: `maxLines = opts.maxLines ?? 12`. Header always line 0 → node budget = `maxLines - 1`.
  - If worker count fits budget: all lines rendered; last worker line branch `└─`, others `├─`.
  - If not: visible set = all nodes with status in {`running`, `failed`, `contract_failed`, `killed`, `blocked`} (spec order), then remaining nodes (spec order) until `budget - 1` lines used. Visible node branches all `├─`. Final line: `└─ … +<hidden> more (<done>/<total> done)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/ui.test.ts`:

```typescript
describe("widget stats, truncation, spinner", () => {
  const many: FleetSpec = {
    fleet_name: "big",
    type: "dag",
    config: { max_concurrent: 4, model: "m" },
    workers: Array.from({ length: 15 }, (_, i) => ({
      id: `w${i}`, type: "research" as const, task: "t", depends_on: [], outputs: [],
    })),
  };

  it("completed nodes show turns, tokens, cost", () => {
    let s = initFleetState(spec);
    s = patchNode("/x", s, "a", { status: "completed", turns: 5, tokens: 1200, cost_usd_estimate: 0.03 });
    const lines = buildWidgetLines(spec, s);
    expect(lines[1]).toContain("✓ a");
    expect(lines[1]).toContain("5 turns");
    expect(lines[1]).toContain("1.2k tok");
    expect(lines[1]).toContain("$0.03");
  });

  it("caps lines at maxLines with overflow summary", () => {
    const lines = buildWidgetLines(many, initFleetState(many));
    expect(lines.length).toBe(12);
    expect(lines[11]).toContain("+5 more");
    expect(lines[11]).toContain("0/15 done");
  });

  it("keeps running nodes visible under truncation", () => {
    let s = initFleetState(many);
    s = patchNode("/x", s, "w14", { status: "running", turns: 2, tokens: 500 });
    const lines = buildWidgetLines(many, s);
    expect(lines.some((l) => l.includes("w14"))).toBe(true);
    expect(lines.length).toBe(12);
  });

  it("respects a smaller maxLines", () => {
    const lines = buildWidgetLines(many, initFleetState(many), { maxLines: 6 });
    expect(lines.length).toBe(6);
    expect(lines[5]).toContain("+11 more");
  });

  it("spinnerFrame animates the running icon", () => {
    const s = patchNode("/x", initFleetState(spec), "a", { status: "running" });
    expect(buildWidgetLines(spec, s, { spinnerFrame: 0 })[1]).toContain("⠋ a");
    expect(buildWidgetLines(spec, s, { spinnerFrame: 2 })[1]).toContain("⠹ a");
  });

  it("header says lgtm streak", () => {
    const loopSpec: FleetSpec = {
      fleet_name: "loop", type: "dag",
      config: { max_concurrent: 2, model: "m", loop: { gate: "reviewer", max_iterations: 5, lgtm_count: 2 } },
      workers: [
        { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
        { id: "b", type: "reviewer", task: "t", depends_on: ["a"], outputs: [] },
      ],
    };
    const lines = buildWidgetLines(loopSpec, initFleetState(loopSpec));
    expect(lines[0]).toContain("lgtm streak 0/2");
  });
});
```

Create `test/controller.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startSpinner, type ActiveFleet } from "../src/controller.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

function runningFleet(): ActiveFleet {
  const spec: FleetSpec = {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1, model: "m" },
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };
  const state = patchNode("/x", initFleetState(spec), "a", { status: "running" });
  return {
    spec,
    fleetRoot: "/x",
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: true,
  };
}

describe("startSpinner", () => {
  it("re-renders the widget with advancing frames until stopped", () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: { setWidget: (_id: string, lines: string[]) => calls.push(lines) },
    } as unknown as ExtensionContext;
    const stop = startSpinner(ctx, runningFleet(), 100);
    vi.advanceTimersByTime(250);
    stop();
    vi.useRealTimers();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].join("\n")).not.toBe(calls[1].join("\n"));
  });

  it("no-ops without UI", () => {
    const ctx = { hasUI: false } as unknown as ExtensionContext;
    const stop = startSpinner(ctx, runningFleet(), 100);
    expect(() => stop()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ui.test.ts test/controller.test.ts`
Expected: FAIL — no truncation/opts in `buildWidgetLines`; `startSpinner` not exported.

- [ ] **Step 3: Implement**

Rewrite `src/ui.ts` as:

```typescript
import type { FleetSpec, FleetState, NodeState, NodeStatus, WorkerSpec } from "./types.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const DEFAULT_MAX_LINES = 12;

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "⠹", blocked: "⊘", killed: "⊘", pending: "○", ready: "○",
};

const DETAIL_STATUSES: ReadonlySet<NodeStatus> = new Set(["running", "completed", "failed", "contract_failed"]);
const ATTENTION_STATUSES: ReadonlySet<NodeStatus> = new Set(["running", "failed", "contract_failed", "killed", "blocked"]);

export interface WidgetOpts {
  maxLines?: number;
  spinnerFrame?: number;
}

export function buildWidgetLines(spec: FleetSpec, state: FleetState, opts: WidgetOpts = {}): string[] {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const done = spec.workers.filter((w) => state.nodes[w.id].status === "completed").length;
  const loop = spec.config.loop;
  let header: string;
  if (loop) {
    const lgtmCount = loop.lgtm_count ?? 1;
    const lastVerdict = state.iterations.length > 0 ? state.iterations[state.iterations.length - 1].verdict : null;
    const streakSegment = loop.gate === "reviewer" ? ` · lgtm streak ${state.lgtm_streak}/${lgtmCount}` : "";
    header = `● fleet: ${spec.fleet_name} · iteration ${state.iteration}/${loop.max_iterations} · last verdict: ${lastVerdict ?? "—"}${streakSegment} (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`;
  } else {
    header = `● fleet: ${spec.fleet_name}  (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`;
  }

  const icon = (s: NodeStatus): string =>
    s === "running" && opts.spinnerFrame !== undefined
      ? SPINNER_FRAMES[opts.spinnerFrame % SPINNER_FRAMES.length]
      : ICON[s];

  const line = (w: WorkerSpec, branch: string): string => {
    const n: NodeState = state.nodes[w.id];
    const detail = DETAIL_STATUSES.has(n.status)
      ? ` · ${n.turns} turns · ${(n.tokens / 1000).toFixed(1)}k tok · $${n.cost_usd_estimate.toFixed(2)}`
      : "";
    const note = n.status_note ? ` · ${n.status_note}` : "";
    const model = w.model ?? spec.config.model ?? "(default)";
    return `${branch} ${icon(n.status)} ${w.id} (${model})${detail}${note}`;
  };

  const budget = Math.max(maxLines - 1, 1);
  if (spec.workers.length <= budget) {
    const lines = [header];
    spec.workers.forEach((w, i) => {
      lines.push(line(w, i === spec.workers.length - 1 ? "└─" : "├─"));
    });
    return lines;
  }

  const attention = spec.workers.filter((w) => ATTENTION_STATUSES.has(state.nodes[w.id].status));
  const rest = spec.workers.filter((w) => !ATTENTION_STATUSES.has(state.nodes[w.id].status));
  const visible = [...attention, ...rest].slice(0, Math.max(budget - 1, 1));
  const hidden = spec.workers.length - visible.length;
  const lines = [header, ...visible.map((w) => line(w, "├─"))];
  lines.push(`└─ … +${hidden} more (${done}/${spec.workers.length} done)`);
  return lines;
}
```

`src/controller.ts`:

- `updateWidget` gains optional frame:

```typescript
export function updateWidget(ctx: ExtensionContext, fleet: ActiveFleet, spinnerFrame?: number): void {
  if (ctx.hasUI) ctx.ui.setWidget("fleet", buildWidgetLines(fleet.spec, fleet.state, { spinnerFrame }));
}
```

- Add `startSpinner`:

```typescript
export function startSpinner(ctx: ExtensionContext, fleet: ActiveFleet, intervalMs = 150): () => void {
  if (!ctx.hasUI) return () => {};
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    updateWidget(ctx, fleet, frame);
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
```

- In `startLoop`: right after `fleet.running = true; fleet.costWarned = false;` add `const stopSpinner = startSpinner(ctx, fleet);`. In the success path, replace `if (ctx.hasUI) ctx.ui.setWidget("fleet", []);` (after `fleet.running = false;`) with:

```typescript
stopSpinner();
updateWidget(ctx, fleet); // keep final per-node stats visible (todo #12)
```

In the catch path, replace `if (ctx.hasUI) ctx.ui.setWidget("fleet", []);` with:

```typescript
stopSpinner();
updateWidget(ctx, fleet);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass. Existing widget assertions (`⠹ a`, `3 turns`, `streak 0/2` substring inside `lgtm streak 0/2`) still hold.

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts src/controller.ts test/ui.test.ts test/controller.test.ts
git commit -m "feat: widget keeps completed-node stats, truncates long fleets, animates spinner, lgtm streak label"
```

---

## Self-Review Notes

- Spec coverage: todo #9 → Task 1; #1 → Task 2; #13 + #2 → Task 3; #14 → Task 4; #3 + #12 → Task 5. ✅
- Type consistency: `ModelRegistryLike`, `validateFleetModels`, `buildWidgetLines(spec, state, opts)`, `startSpinner`, `ThinkingLevelName` used consistently across tasks. ✅
- Task 2 note: if executed before Task 3, `FleetConfig.model` is still `string` — effort steps do not touch it; Task 3 flips it to optional. Order fixed 1→5.
