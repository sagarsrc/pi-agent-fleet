# Fleet Dynamic Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let fleets grow on the fly — workers request nodes via `output/node-requests.json`, users/agents insert nodes via `fleet_add_node` / `/fleet add` (todo.md #6, #11).

**Architecture:** Scheduler auto-initializes unknown spec workers each dispatch pass and exposes `onNodeCompleted`/`onNodeAdded` hooks; new `src/insert.ts` validates the merged graph (full `validateFleetSpec`) and persists spec/dirs/prompts; controller wires the sideband contract.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, pi extension API, typebox.

**Worktree root (all paths resolve here):** `/Users/sagar/work/pi-fleet-extension/.worktrees/fleet-dynamic`

## Global Constraints

- All local imports use the `.js` suffix (NodeNext ESM).
- `npm test` AND `npm run typecheck` green at the end of every task.
- No new dependencies.
- Commit style: conventional (`feat:`, `fix:`). One commit per task.
- Insertion is atomic per batch: any validation/model error rejects the WHOLE batch — no partial inserts.
- When the fleet is running, the SCHEDULER owns `state.nodes` initialization for inserted workers (auto-init); `insertWorkers` must not patch state mid-run. When not running, `insertWorkers` initializes state and persists `state.json`.
- Insertion into a fleet whose state status is `completed` is refused: message `fleet is completed; relaunch a node instead of inserting`.
- `fleet.json` writes use atomic tmp+rename (same pattern as `writeState`).
- New nodes never set `model`/`effort` from worker sideband docs; model refs ARE validated/canonicalized when explicitly present.

---

### Task 1: Scheduler auto-init + `onNodeAdded` + `onNodeCompleted` hooks

**Files:**
- Modify: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Produces: `RunFleetOpts.onNodeAdded?: (worker: WorkerSpec) => void | Promise<void>` — awaited after auto-init of a previously unknown spec worker, before it can dispatch. `RunFleetOpts.onNodeCompleted?: (nodeId: string) => Promise<string | undefined | void>` — awaited right after a node's successful contract patch; a returned string is patched as the node's `status_note`.
- Consumes: existing scheduler semantics unchanged for static specs.

- [ ] **Step 1: Write the failing tests**

Append to `test/scheduler.test.ts`:

```typescript
it("auto-initializes spec workers added mid-run and dispatches them", async () => {
  const sp = spec();
  const added: string[] = [];
  const s = await runFleet({
    spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
    spawn: async (id) => {
      if (id === "a") sp.workers.push({ id: "c", type: "write", task: "t", depends_on: ["a"], outputs: [] });
      return { ok: true, turns: 1, tokens: 10 };
    },
    onNodeAdded: async (w) => { added.push(w.id); },
  });
  expect(added).toEqual(["c"]);
  expect(s.nodes.c.status).toBe("completed");
});

it("patches status_note returned by onNodeCompleted", async () => {
  const s = await runFleet({
    spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
    spawn: async () => ({ ok: true, turns: 1, tokens: 10 }),
    onNodeCompleted: async (id) => (id === "a" ? "a-note" : undefined),
  });
  expect(s.nodes.a.status_note).toBe("a-note");
  expect(s.nodes.b.status_note).toBeUndefined();
});

it("grows the DAG from onNodeCompleted and runs the new node", async () => {
  const sp = spec();
  const s = await runFleet({
    spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
    spawn: async () => ({ ok: true, turns: 1, tokens: 10 }),
    onNodeCompleted: async (id) => {
      if (id === "b") sp.workers.push({ id: "c", type: "write", task: "t", depends_on: ["b"], outputs: [] });
    },
  });
  expect(s.nodes.c.status).toBe("completed");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL — `onNodeAdded`/`onNodeCompleted` unknown properties; node `c` never initialized.

- [ ] **Step 3: Implement**

`src/scheduler.ts`:

- Add `WorkerSpec` to the type imports from `./types.js`.
- `RunFleetOpts` gains:

```typescript
onNodeAdded?: (worker: WorkerSpec) => void | Promise<void>;
onNodeCompleted?: (nodeId: string) => Promise<string | undefined | void>;
```

- In `runPass`, at the very top of the `while (true)` loop (before the deps-failed blocking pass):

```typescript
// auto-initialize workers inserted into the spec after the run started
for (const w of spec.workers) {
  if (!state.nodes[w.id]) {
    state = {
      ...state,
      nodes: {
        ...state.nodes,
        [w.id]: { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
      },
    };
    await writeState(fleetRoot, state);
    await opts.onNodeAdded?.(w);
    opts.onNodeChange?.(w.id, state.nodes[w.id]);
  }
}
```

- In the spawn result handler, after the successful-contract patch (the `await patch(w.id, { status: contract.ok ? "completed" : "contract_failed", ... })` call), add:

```typescript
if (contract.ok) {
  const note = await opts.onNodeCompleted?.(w.id);
  if (note) await patch(w.id, { status_note: note });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "feat: scheduler auto-initializes inserted nodes, onNodeAdded and onNodeCompleted hooks"
```

---

### Task 2: `src/insert.ts` + controller sideband wiring

**Files:**
- Create: `src/insert.ts`
- Modify: `src/controller.ts` (`onNodeAdded`, `onNodeCompleted` implementations)
- Test: `test/insert.test.ts`, `test/controller.test.ts`

**Interfaces:**
- Produces: `insertWorkers(fleet: ActiveFleet, raw: unknown, registry: ModelRegistryLike): Promise<{ ok: boolean; message: string; inserted?: string[] }>`.
- Consumes: Task 1 hooks; `validateFleetSpec`; `buildWorkerPrompt`; `writeState`.

- [ ] **Step 1: Write the failing tests**

`test/insert.test.ts`:

```typescript
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveFleet } from "../src/controller.js";
import { insertWorkers } from "../src/insert.js";
import { initFleetState, patchNode, writeState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { fakeModel, registryFor } from "./fakes.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

async function plannedFleet(running = false): Promise<ActiveFleet> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-insert-"));
  const state = initFleetState(spec);
  await writeState(fleetRoot, state);
  return {
    spec: structuredClone(spec),
    fleetRoot,
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running,
    sessions: new Map(),
    killedNodes: new Set(),
  };
}

const registry = registryFor([fakeModel("openai", "gpt-5.4"), fakeModel("kimi", "k3")]);

describe("insertWorkers", () => {
  it("inserts a node on a non-running fleet: state, dirs, prompt, fleet.json", async () => {
    const fleet = await plannedFleet(false);
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "do c", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(true);
    expect(r.inserted).toEqual(["c"]);
    expect(fleet.spec.workers.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(fleet.state.nodes.c.status).toBe("pending");
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.workers.map((w: { id: string }) => w.id)).toContain("c");
    const state = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
    expect(state.nodes.c.status).toBe("pending");
    expect((await stat(join(fleet.fleetRoot, "workers", "c", "output"))).isDirectory()).toBe(true);
    const prompt = await readFile(join(fleet.fleetRoot, "workers", "c", "prompt.md"), "utf-8");
    expect(prompt).toContain("do c");
  });

  it("does not touch state.json when the fleet is running", async () => {
    const fleet = await plannedFleet(true);
    const before = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "do c", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(true);
    const after = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
    expect(after.nodes.c).toBeUndefined();
    expect(after).toEqual(before);
    expect(fleet.state.nodes.c).toBeUndefined(); // scheduler auto-init owns state mid-run
  });

  it("rejects the whole batch on any validation error", async () => {
    const fleet = await plannedFleet(false);
    const r = await insertWorkers(fleet, [
      { id: "c", type: "write", task: "ok", depends_on: ["b"] },
      { id: "a", type: "write", task: "dupe", depends_on: [] },
    ], registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("duplicate");
    expect(fleet.spec.workers.length).toBe(2);
  });

  it("rejects unknown deps and cycles", async () => {
    const fleet = await plannedFleet(false);
    expect((await insertWorkers(fleet, [{ id: "c", type: "write", task: "t", depends_on: ["ghost"] }], registry)).ok).toBe(false);
    const cyc = await insertWorkers(fleet, [
      { id: "c", type: "write", task: "t", depends_on: ["d"] },
      { id: "d", type: "write", task: "t", depends_on: ["c"] },
    ], registry);
    expect(cyc.ok).toBe(false);
    expect(cyc.message).toContain("CYCLE");
  });

  it("canonicalizes explicit model refs and rejects bad ones", async () => {
    const fleet = await plannedFleet(false);
    const ok = await insertWorkers(fleet, [{ id: "c", type: "write", task: "t", depends_on: ["b"], model: "k3" }], registry);
    expect(ok.ok).toBe(true);
    expect(fleet.spec.workers[2].model).toBe("kimi/k3");
    const bad = await insertWorkers(fleet, [{ id: "e", type: "write", task: "t", depends_on: ["b"], model: "ghost" }], registry);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("ghost");
  });

  it("refuses insertion into a completed fleet", async () => {
    const fleet = await plannedFleet(false);
    fleet.state = { ...fleet.state, status: "completed" };
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "t", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("completed");
  });

  it("rejects empty/malformed input", async () => {
    const fleet = await plannedFleet(false);
    expect((await insertWorkers(fleet, [], registry)).ok).toBe(false);
    expect((await insertWorkers(fleet, { nope: true }, registry)).ok).toBe(false);
    expect((await insertWorkers(fleet, "junk", registry)).ok).toBe(false);
  });

  it("enforces loop-gate rules on the merged graph", async () => {
    const fleet = await plannedFleet(false);
    fleet.spec.config.loop = { gate: "reviewer", max_iterations: 2, lgtm_count: 1 };
    fleet.spec.workers[1].outputs = [{ path: "output/review.md", kind: "verdict", required: true }];
    const r = await insertWorkers(fleet, [{
      id: "c", type: "reviewer", task: "second reviewer", depends_on: ["b"],
      outputs: [{ path: "output/review2.md", kind: "verdict", required: true }],
    }], registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("verdict");
  });
});
```

Append to `test/controller.test.ts`:

```typescript
describe("node request sideband", () => {
  it("inserts workers requested by a completed node", async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-sideband-"));
    const fleet = runningFleet();
    fleet.fleetRoot = fleetRoot;
    await mkdir(join(fleetRoot, "workers", "a", "output"), { recursive: true });
    await writeFile(join(fleetRoot, "workers", "a", "output", "node-requests.json"),
      JSON.stringify({ workers: [{ id: "c", type: "write", task: "extra", depends_on: ["a"] }] }), "utf-8");
    const registry = { getAvailable: () => [], getAll: () => [] };
    const note = await drainNodeRequests(fleet, "a", registry);
    expect(note).toBeUndefined();
    expect(fleet.spec.workers.map((w) => w.id)).toContain("c");
  });

  it("returns a note for invalid request JSON", async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-sideband-"));
    const fleet = runningFleet();
    fleet.fleetRoot = fleetRoot;
    await mkdir(join(fleetRoot, "workers", "a", "output"), { recursive: true });
    await writeFile(join(fleetRoot, "workers", "a", "output", "node-requests.json"), "{junk", "utf-8");
    const registry = { getAvailable: () => [], getAll: () => [] };
    const note = await drainNodeRequests(fleet, "a", registry);
    expect(note).toContain("node-requests");
  });

  it("returns undefined when no sideband file exists", async () => {
    const fleet = runningFleet();
    fleet.fleetRoot = await mkdtemp(join(tmpdir(), "fleet-sideband-"));
    const registry = { getAvailable: () => [], getAll: () => [] };
    expect(await drainNodeRequests(fleet, "a", registry)).toBeUndefined();
  });
});
```

(`mkdir`, `writeFile` may need adding to the fs imports in that test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/insert.test.ts test/controller.test.ts`
Expected: FAIL — `../src/insert.js` missing; `drainNodeRequests` not exported.

- [ ] **Step 3: Implement**

`src/insert.ts` (complete file):

```typescript
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveFleet } from "./controller.js";
import { validateFleetSpec } from "./dag.js";
import { resolveModelReference, type ModelRegistryLike } from "./model-resolution.js";
import { buildWorkerPrompt } from "./prompts.js";
import { writeState } from "./state.js";

export interface InsertResult {
  ok: boolean;
  message: string;
  inserted?: string[];
}

async function persistFleetJson(fleet: ActiveFleet): Promise<void> {
  const path = join(fleet.fleetRoot, "fleet.json");
  const tmp = join(fleet.fleetRoot, `.fleet.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(fleet.spec, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

export async function insertWorkers(
  fleet: ActiveFleet,
  raw: unknown,
  registry: ModelRegistryLike,
): Promise<InsertResult> {
  if (fleet.state.status === "completed") {
    return { ok: false, message: "fleet is completed; relaunch a node instead of inserting" };
  }
  const list = Array.isArray(raw) ? raw : (raw as { workers?: unknown[] } | null)?.workers;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, message: "no workers to insert (expected an array or { \"workers\": [...] })" };
  }
  const candidate = {
    fleet_name: fleet.spec.fleet_name,
    type: "dag",
    config: fleet.spec.config,
    workers: [...fleet.spec.workers, ...list],
  };
  const v = validateFleetSpec(candidate);
  if (!v.ok) return { ok: false, message: `invalid node insertion:\n${v.errors.join("\n")}` };
  const fresh = v.spec.workers.slice(fleet.spec.workers.length);
  for (const w of fresh) {
    if (w.model) {
      const r = resolveModelReference(registry, w.model);
      if (!r.ok) return { ok: false, message: `worker "${w.id}" model: ${r.error}` };
      w.model = `${r.model.provider}/${r.model.id}`;
    }
  }
  fleet.spec.workers.push(...fresh);
  await persistFleetJson(fleet);
  for (const w of fresh) {
    await mkdir(join(fleet.fleetRoot, "workers", w.id, "output"), { recursive: true });
    const prompt = buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: w.id, fleetRoot: fleet.fleetRoot });
    await writeFile(join(fleet.fleetRoot, "workers", w.id, "prompt.md"), prompt, "utf-8");
  }
  if (!fleet.running) {
    const nodes = { ...fleet.state.nodes };
    for (const w of fresh) {
      nodes[w.id] = { status: "pending" as const, turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
    }
    fleet.state = { ...fleet.state, nodes };
    await writeState(fleet.fleetRoot, fleet.state);
  }
  const ids = fresh.map((w) => w.id);
  return { ok: true, message: `inserted ${ids.join(", ")}`, inserted: ids };
}
```

`src/controller.ts`:

- New export (imports: `insertWorkers` from `./insert.js`; `readFile` already imported):

```typescript
export async function drainNodeRequests(
  fleet: ActiveFleet,
  nodeId: string,
  registry: ModelRegistryLike,
): Promise<string | undefined> {
  const p = join(fleet.fleetRoot, "workers", nodeId, "output", "node-requests.json");
  let raw: string;
  try {
    raw = await readFile(p, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `node-requests.json invalid JSON: ${(e as Error).message}`;
  }
  const r = await insertWorkers(fleet, parsed, registry);
  if (!r.ok) return `node-requests rejected: ${r.message.split("\n")[0]}`;
  return undefined;
}
```

- In `startLoop`'s `runFleet({...})` call, wire both hooks:

```typescript
onNodeAdded: () => {
  updateWidget(ctx, fleet);
},
onNodeCompleted: async (nodeId) => {
  const note = await drainNodeRequests(fleet, nodeId, ctx.modelRegistry);
  if (!note) updateWidget(ctx, fleet);
  return note;
},
```

(Widget refresh on insertion; when a note is returned the scheduler patches it and fires `onNodeChange`, which already refreshes.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/insert.ts src/controller.ts test/insert.test.ts test/controller.test.ts
git commit -m "feat: insertWorkers module and node-requests sideband for worker-driven DAG growth"
```

---

### Task 3: `fleet_add_node` tool + `/fleet add` + prompt contract docs

**Files:**
- Modify: `src/prompts.ts` (sideband contract section)
- Modify: `src/tools.ts` (`fleet_add_node`)
- Modify: `src/command.ts` (`/fleet add`)
- Test: `test/prompts.test.ts`

**Interfaces:**
- Consumes: Task 2's `insertWorkers`, `drainNodeRequests`; existing `WorkerSchema` in tools.ts.
- Produces: `fleet_add_node` tool; `/fleet add <json>` command; "Requesting additional nodes" prompt section containing the exact string `node-requests.json`.

- [ ] **Step 1: Write the failing test**

Append to `test/prompts.test.ts`:

```typescript
it("documents the node-requests sideband contract", () => {
  const prompt = buildWorkerPrompt({ spec, state: initFleetState(spec), workerId: "a", fleetRoot: "/fr" });
  expect(prompt).toContain("node-requests.json");
  expect(prompt).toContain("Requesting additional nodes");
});
```

(Check the file's existing fixture names — reuse its spec/state construction pattern; `buildWorkerPrompt` args: `{ spec, state, workerId, fleetRoot }`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — prompt has no such section.

- [ ] **Step 3: Implement**

`src/prompts.ts` — insert this section right before the `## Your output obligations` block:

```typescript
out.push("## Requesting additional nodes (optional)", "");
out.push(`If you discover work this DAG cannot do as currently shaped, write ${workerDir}/output/node-requests.json:`, "");
out.push(
  `{ "workers": [{ "id": "kebab-case", "type": "research|code-run|reviewer|write|read-only", "task": "self-contained instructions", "depends_on": ["${workerId}"], "outputs": [{ "path": "output/file.md", "kind": "markdown", "required": true }] }] }`,
  "",
);
out.push("The runner validates the merged graph (unique ids, known deps, acyclic, loop-gate rules) and inserts valid nodes as pending. Invalid batches are rejected atomically and noted on your node. Do not set model or effort fields — the runner assigns them. Depend on your own id when the new node needs your outputs.", "");
```

`src/tools.ts` — register (import `insertWorkers` from `./insert.js`):

```typescript
pi.registerTool({
  name: "fleet_add_node",
  label: "Fleet Add Node",
  description: "Insert one or more worker nodes into the active fleet's DAG on the fly. The merged graph is validated (unique ids, known deps, acyclic, loop-gate rules); inserted nodes start as pending and dispatch as soon as their deps complete — including mid-run. Refused on completed fleets.",
  promptSnippet: "Add worker nodes to the active fleet DAG.",
  parameters: Type.Object({
    workers: Type.Array(WorkerSchema, { minItems: 1 }),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const active = activeFleet.current;
    if (!active) return textResult("no fleet planned yet");
    await currentState(active);
    const r = await insertWorkers(active, params.workers, ctx.modelRegistry);
    if (r.ok) updateWidget(ctx, active);
    return textResult(r.message, { inserted: r.inserted ?? [] });
  },
});
```

`src/command.ts` — add before the final usage fallback (import `insertWorkers` from `./insert.js`):

```typescript
if (cmd === "add") {
  const body = args.trim().split(/\s+/).slice(1).join(" ");
  if (!body) {
    ctx.ui.notify('usage: /fleet add \'{"workers": [{"id": "x", "type": "research", "task": "...", "depends_on": []}]}\'', "warning");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    ctx.ui.notify(`invalid JSON: ${(e as Error).message}`, "error");
    return;
  }
  await currentState(active);
  const r = await insertWorkers(active, parsed, ctx.modelRegistry);
  ctx.ui.notify(r.message, r.ok ? "info" : "error");
  if (r.ok) updateWidget(ctx, active);
  return;
}
```

Update the `/fleet` command description and final usage string to include `/fleet add <json>`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts src/tools.ts src/command.ts test/prompts.test.ts
git commit -m "feat: fleet_add_node tool, /fleet add command, node-requests prompt contract"
```

---

## Self-Review Notes

- Spec coverage: scheduler auto-init + hooks → Task 1; insertion module + sideband → Task 2; explicit tool/command + prompt docs → Task 3. ✅
- Placeholder scan: all code complete. ✅
- Type consistency: `InsertResult`, `drainNodeRequests(fleet, nodeId, registry) → Promise<string | undefined>`, `onNodeCompleted` return type (`Promise<string | undefined | void>`) — controller's wiring returns `note` (string|undefined) ✓; scheduler test's `onNodeCompleted` pushing without returning → `void` ✓.
- Task 2's controller tests reuse `runningFleet()` helper (has `sessions`/`killedNodes` from the control plan). Task 2 depends on Task 1's scheduler hooks. Order fixed 1→3.
