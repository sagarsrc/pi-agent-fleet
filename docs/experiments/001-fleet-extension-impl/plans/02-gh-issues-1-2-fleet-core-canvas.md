# GitHub Issues #1 + #2 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 5 fleet-core bugs from issue #1 (approval-gate deaths, relaunch lost-wakeup, blocked nodes uneditable/unkillable, trivial file-exists contracts, zero-cost reporting) and all 4 canvas UX problems from issue #2 (uncopyable errors, left-right DAG layout, misplaced instructions panel, slop sidebar cards).

**Architecture:** Fleet core fixes land in `src/prompts.ts`, `src/state.ts`, `src/scheduler.ts`, `src/controller.ts`, `src/tools.ts`, `src/command.ts`, `src/edits.ts`, `src/contracts.ts`. Canvas fixes extract testable pure logic into a new `src/canvas-layout.ts` imported by `src/canvas-client.tsx` (bundled by esbuild inside `src/canvas.ts`); CSS lives in the HTML template in `src/canvas.ts`.

**Tech Stack:** TypeScript ESM, vitest (`npm test`), `npx tsc --noEmit`, React 19 + @xyflow/react (canvas client), esbuild (bundle).

**Spec:** GitHub issues #1 and #2 on sagarsrc/pi-agent-fleet (fetched 2026-08-17; bodies quoted in ledger workspace `spec-issue-1.md` / `spec-issue-2.md`).

## Global Constraints

- TDD is mandatory: write the failing test, watch it fail, write minimal code, watch it pass. No production code without a failing test first.
- `npm test` must stay green (baseline: 208 tests) and `npx tsc --noEmit` must be clean after every task.
- No new runtime dependencies. No changes to `package.json` except none needed.
- ESM imports use `.js` suffix (`import { x } from "./state.js"`), matching existing style.
- Node status vocabulary is fixed: `"pending" | "ready" | "running" | "completed" | "failed" | "contract_failed" | "killed" | "blocked"` (`src/types.ts`). `TERMINAL_NODE_STATUSES = completed, failed, contract_failed, killed, blocked`.
- Live fleet smoke tests (Task 8) use ONLY dead-simple write tasks and model `openai-codex/gpt-5.4-mini` for workers — token waste is a hard fail.
- Worker-type tool restrictions (`WORKER_TYPE_TOOLS` in `src/types.ts`) are untouched.
- Commit per task: `fix(fleet): ...` / `fix(canvas): ...` conventional commits.

---

### Task 0: Baseline — commit WIP fleet-recovery fallback with a test

**Files:**
- Modify: `test/fleet-recovery.test.ts`
- Already-modified (uncommitted in main checkout, carried into branch): `src/fleet-recovery.ts`

**Context:** The working tree has an uncommitted change to `src/fleet-recovery.ts` (bare `fleet.json`-only root → `readDiskFleet` synthesizes a fresh `initFleetState(spec)` instead of throwing). It has no test. Commit it with one.

- [ ] **Step 1: Write the failing test** (it will actually pass — the code predates this plan; ledger ruling covers this TDD exception)

```typescript
it("synthesizes a pending state for a bare fleet.json-only root", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-bare-"));
  await writeFile(join(root, "fleet.json"), JSON.stringify(minimalSpec), "utf-8");
  const fleet = await readDiskFleet(root);
  expect(fleet.state.status).toBe("planned");
  expect(Object.keys(fleet.state.nodes)).toEqual(minimalSpec.workers.map((w) => w.id));
});
```

Match existing imports/helpers in `test/fleet-recovery.test.ts` (`minimalSpec`, `mkdtemp`, etc.) — read the file first.

- [ ] **Step 2:** Run `npx vitest run test/fleet-recovery.test.ts` → PASS. If it fails, the WIP code is wrong — stop and report.
- [ ] **Step 3:** `npm test` → all green; `npx tsc --noEmit` clean.
- [ ] **Step 4:** Commit

```bash
git add src/fleet-recovery.ts test/fleet-recovery.test.ts
git commit -m "fix(fleet): tolerate bare fleet.json roots in readDiskFleet"
```

---

### Task 1: Autonomy preamble in worker prompts (issue #1, bug 1)

**Files:**
- Modify: `src/prompts.ts` (top of `buildWorkerPrompt`)
- Test: `test/prompts.test.ts`

**Interfaces:**
- Produces: worker prompt text now starts with an `## Autonomy contract` section before `## Task`. No signature changes.

- [ ] **Step 1: Write failing tests** in `test/prompts.test.ts` (follow existing test style there):

```typescript
it("prepends an autonomy contract before the task section", () => {
  const p = buildWorkerPrompt({ spec, state, workerId: "a", fleetRoot: "/f" });
  const auto = p.indexOf("## Autonomy contract");
  const task = p.indexOf("## Task");
  expect(auto).toBeGreaterThanOrEqual(0);
  expect(task).toBeGreaterThan(auto);
});

it("autonomy contract forbids approval gates and open questions", () => {
  const p = buildWorkerPrompt({ spec, state, workerId: "a", fleetRoot: "/f" });
  expect(p).toContain("PRE-APPROVED");
  expect(p).toContain("no human");
  expect(p).toContain("Do not end your turn with a question");
});
```

(Use whatever spec/state fixtures `test/prompts.test.ts` already defines.)

- [ ] **Step 2:** Run `npx vitest run test/prompts.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement.** In `src/prompts.ts`, immediately after `const out: string[] = [];` and before the existing `out.push(\`# Fleet worker: ...\`)`, insert:

```typescript
  out.push(
    "## Autonomy contract (read first)",
    "",
    "You are an unattended fleet worker — there is no human watching this session and nobody will answer questions.",
    "- Everything in this prompt is PRE-APPROVED. Do not ask for approval; do the work.",
    "- Do NOT invoke any skill or workflow with a human approval gate (e.g. brainstorming hard-gates). Skip gated steps and execute the task directly.",
    "- Do not end your turn with a question, a plan awaiting approval, or an 'Approve?' prompt. End your turn only when every REQUIRED output below exists on disk.",
    "- Ambiguity is yours to resolve: decide, record the decision in your output, and continue.",
    "",
  );
```

- [ ] **Step 4:** `npx vitest run test/prompts.test.ts` → PASS; then `npm test` green.
- [ ] **Step 5:** Commit `fix(fleet): autonomy preamble in worker prompts (issue #1 bug 1)`

---

### Task 2: Relaunch while fleet is running (issue #1, bug 2)

**Root cause:** `fleet_relaunch` (tools.ts) and `/fleet relaunch` (command.ts) return early with `"fleet is running"` and do nothing; the scheduler owns state in-memory, so nothing ever re-dispatches the node.

**Files:**
- Modify: `src/state.ts` (extract `relaunchResetIds`), `src/scheduler.ts` (new `relaunchRequests` opt), `src/controller.ts` (`relaunchRequests` on `ActiveFleet`, shared `requestRelaunch`, pass-through in `startLoop`), `src/tools.ts` + `src/command.ts` (use `requestRelaunch`), `src/fleet-recovery.ts` (init the new field), `test/fakes.ts` (init field if it builds `ActiveFleet`).
- Test: `test/scheduler-relaunch.test.ts`, `test/fleet-recovery.test.ts` (compile-only impact)

**Interfaces:**
- Produces:
  - `export function relaunchResetIds(spec: FleetSpec, nodeId: string): string[]` in `src/state.ts` — returns `[nodeId, ...downstreamBlockedIds]` (transitive dependents whose current status is `blocked` — computed against a passed-in state, see signature below).
  - `export function requestRelaunch(fleet: ActiveFleet, nodeId: string, model: string | undefined, registry: ModelRegistryLike): Promise<string>` in `src/controller.ts` — returns the user-facing message; used by BOTH tools.ts and command.ts.
  - `RunFleetOpts.relaunchRequests?: Set<string>` in `src/scheduler.ts`.
  - `ActiveFleet.relaunchRequests: Set<string>` in `src/controller.ts`.

**Design decision (ledger):** final `relaunchResetIds` signature:

```typescript
export function relaunchResetIds(spec: FleetSpec, state: FleetState, nodeId: string): string[] {
  // [nodeId] + every transitive dependent whose status is "blocked"
}
```

Refactor existing `resetForRelaunch` (state.ts:124) to use it — behavior unchanged.

- [ ] **Step 1: Write failing tests** in `test/scheduler-relaunch.test.ts`:

```typescript
it("re-dispatches a contract_failed node queued via relaunchRequests mid-run", async () => {
  // spec: workers a (no deps, will contract-fail once), slow (no deps, blocks until released)
  // max_concurrent: 2
  const spec: FleetSpec = {
    fleet_name: "t", type: "dag", config: { max_concurrent: 2 },
    workers: [
      { id: "a", type: "write", task: "t", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }] },
      { id: "slow", type: "write", task: "t", depends_on: [], outputs: [] },
    ],
  };
  // spawn: "a" first call returns ok but writes nothing (=> contract_failed);
  // after relaunchRequests.add("a"), second call writes output/a.md and returns ok.
  // "slow" spawn returns a promise the test resolves after a's first failure.
  // Assert: a is dispatched twice, final state.nodes.a.status === "completed".
});

it("relaunch of a failed upstream resets blocked downstream to pending", async () => {
  // workers: root (fails first, then succeeds), mid depends_on root (becomes blocked), 
  // relaunchRequests.add("root") mid-run => mid ends completed, never stays blocked.
});

it("ignores relaunchRequests for nodes that are running or completed", async () => {
  // add a completed node id to relaunchRequests: no re-dispatch.
});
```

Also a state-level unit test in `test/state-cost.test.ts` or a new small describe in `test/scheduler-relaunch.test.ts` (match existing file conventions):

```typescript
it("relaunchResetIds returns self plus transitively blocked dependents", () => {
  // a -> b (blocked) -> c (blocked); d independent (completed)
  // expect relaunchResetIds(spec, state, "a") to equal ["a", "b", "c"] (order: self first)
});
```

- [ ] **Step 2:** Run `npx vitest run test/scheduler-relaunch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**

`src/state.ts` — add and refactor:

```typescript
export function relaunchResetIds(spec: FleetSpec, state: FleetState, nodeId: string): string[] {
  if (!state.nodes[nodeId]) throw new Error(`unknown node "${nodeId}"`);
  const dependents: Record<string, string[]> = {};
  for (const w of spec.workers) for (const dep of w.depends_on) (dependents[dep] ??= []).push(w.id);
  const out = [nodeId];
  const seen = new Set(out);
  const queue = [nodeId];
  while (queue.length) {
    for (const d of dependents[queue.shift()!] ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (state.nodes[d]?.status === "blocked") out.push(d);
      queue.push(d);
    }
  }
  return out;
}
```

(Rewrite `resetForRelaunch` body to walk `relaunchResetIds(spec, state, nodeId)` — keep its exact current return behavior.)

`src/scheduler.ts` — in `RunFleetOpts` add `relaunchRequests?: Set<string>;`. In `runPass`, at the top of the `while (true)` body (before the auto-init block), add:

```typescript
      // apply queued relaunch requests (lost-wakeup fix, issue #1 bug 2)
      if (opts.relaunchRequests && opts.relaunchRequests.size > 0) {
        for (const id of [...opts.relaunchRequests]) {
          opts.relaunchRequests.delete(id);
          const n = state.nodes[id];
          if (!n || !FAILED.has(n.status)) continue;
          for (const rid of relaunchResetIds(spec, state, id)) {
            const rn = state.nodes[rid];
            if (!rn) continue;
            if (rid === id && !FAILED.has(rn.status)) continue;
            if (rid !== id && rn.status !== "blocked") continue;
            await patch(rid, {
              status: "pending",
              started_at: undefined,
              ended_at: undefined,
              turns: 0,
              tokens: 0,
              cost_usd_estimate: 0,
              produced_outputs: [],
              contract_result: undefined,
              status_note: undefined,
            });
          }
        }
      }
```

Import `relaunchResetIds` from `./state.js`.

`src/controller.ts` — add to `ActiveFleet`: `relaunchRequests: Set<string>;`. Add:

```typescript
export async function requestRelaunch(
  fleet: ActiveFleet,
  nodeId: string,
  model: string | undefined,
  registry: ModelRegistryLike,
): Promise<string> {
  const worker = fleet.spec.workers.find((w) => w.id === nodeId);
  if (!worker) return `unknown node "${nodeId}"`;
  const node = fleet.state.nodes[nodeId];
  const relaunchable: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed"]);
  if (!node || !relaunchable.has(node.status)) {
    return `node "${nodeId}" status ${node?.status ?? "missing"} cannot be relaunched; must be failed, contract_failed, or killed`;
  }
  if (model) {
    const resolved = resolveModelReference(registry, model);
    if (!resolved.ok) return resolved.error;
    const canonical = `${resolved.model.provider}/${resolved.model.id}`;
    fleet.spec.workers = fleet.spec.workers.map((w) => (w.id === nodeId ? { ...w, model: canonical } : w));
    await persistFleetJson(fleet);
  }
  prepareRelaunch(fleet, nodeId);
  if (fleet.running) {
    fleet.relaunchRequests.add(nodeId);
    return `relaunch queued for ${nodeId} (fleet running; dispatches on next scheduler pass)`;
  }
  fleet.state = resetForRelaunch(fleet.state, fleet.spec, nodeId);
  await writeState(fleet.fleetRoot, fleet.state);
  await writeWorkerPrompts(fleet);
  return `RELAUNCH_NOW:${nodeId}`;
}
```

(The `RELAUNCH_NOW:` prefix lets callers decide to kick `startLoop`; keep it internal — callers strip it. Simpler alternative the implementer may choose: return `{ message, startNow: boolean }` — pick one, use it in both call sites.)

In `startLoop`'s `runFleet({...})` call add `relaunchRequests: fleet.relaunchRequests,`.

`src/tools.ts` `fleet_relaunch`: replace the `if (active.running) return textResult("fleet is running");` early-return and the inline relaunch logic with: `await currentState(fleet)`; completed-fleet guard stays; then `const msg = await requestRelaunch(fleet, params.node_id, params.model, ctx.modelRegistry);` — if msg starts with `RELAUNCH_NOW:` → `void startLoop(fleet, ctx, false, true)` and reply `fleet relaunch requested for <id>`; else reply msg.

`src/command.ts` `/fleet relaunch`: same replacement (drop its `fleet is running` early-return; on `RELAUNCH_NOW:` → `void startLoop(active, ctx, false, true)`).

`src/fleet-recovery.ts` `readDiskFleet` and any `recoverLatestFleet` construction of `ActiveFleet`: add `relaunchRequests: new Set(),`. Same in `src/tools.ts` `fleet_plan`'s `activeFleet.current = {...}` literal and `test/fakes.ts` if present.

Update the `fleet_relaunch` tool description: `"Relaunch a failed node and any blocked downstream dependents. Works while the fleet is running (queued for the next scheduler pass) and after it stops. Optionally override the worker model for this run."`

- [ ] **Step 4:** `npx vitest run test/scheduler-relaunch.test.ts` PASS → `npm test` green → `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `fix(fleet): relaunch queued into running scheduler (issue #1 bug 2)`

---

### Task 3: Blocked nodes editable and killable (issue #1, bug 3)

**Files:**
- Modify: `src/edits.ts`, `src/controller.ts` (`killFleet`), `src/scheduler.ts` (honor `nodeKills` for blocked nodes), `src/tools.ts` (fleet_edit description).
- Test: `test/edits.test.ts`, `test/controller.test.ts` (or `test/scheduler.test.ts` for the running-kill path — match existing conventions).

**Interfaces:**
- Consumes: nothing from Task 2 (independent).
- Produces: no new exports.

- [ ] **Step 1: Write failing tests:**

```typescript
// test/edits.test.ts
it("allows task edit on a blocked node", async () => {
  // node status "blocked" => editNode(fleet, "n", "task", "new task") returns { ok: true }
  // and fleet.spec worker task is updated.
});

// kill tests (place in the file that already tests killFleet)
it("kills a blocked node immediately when fleet is not running", async () => {
  // active.running = false, node blocked => killFleet("n") => state.nodes.n.status === "killed"
});

it("kills a blocked node at the next scheduler pass while running", async () => {
  // runFleet with nodeKills containing a blocked node id => node patched to "killed"
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**

`src/edits.ts`: `const EDITABLE_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set(["pending", "ready", "failed", "contract_failed", "killed", "blocked"]);` and update the refusal message to `only pending, blocked, failed, contract_failed, or killed nodes can be edited`.

`src/controller.ts` `killFleet`: change the terminal guard from

```typescript
if (TERMINAL_NODE_STATUSES.has(node.status)) return `node "${target}" already ${node.status}`;
```

to

```typescript
if (TERMINAL_NODE_STATUSES.has(node.status) && node.status !== "blocked") return `node "${target}" already ${node.status}`;
```

(blocked nodes fall through to the existing `killedNodes.add(target)` + not-running direct-patch path, which already handles `!active.running` by patching `killed` and writing state.)

`src/scheduler.ts` `runPass`: immediately before the `// dispatch ready` section, add:

```typescript
      // honor kill requests for not-yet-running nodes (incl. blocked, issue #1 bug 3)
      for (const w of spec.workers) {
        const n = state.nodes[w.id];
        if (!n) continue;
        if (!opts.nodeKills?.has(w.id)) continue;
        if (n.status === "pending" || n.status === "ready" || n.status === "blocked") {
          await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
        }
      }
```

`src/tools.ts` `fleet_edit` description: replace `"Edits to running, completed, or blocked nodes are refused; failed, contract_failed, and killed nodes can be edited so relaunch uses the updated task."` with `"Edits to running or completed nodes are refused; pending, blocked, failed, contract_failed, and killed nodes can be edited (blocked nodes have not started — nothing to invalidate)."`

- [ ] **Step 4:** Tests PASS, `npm test` green, tsc clean.
- [ ] **Step 5:** Commit `fix(fleet): blocked nodes editable and killable (issue #1 bug 3)`

---

### Task 4: file-exists contract requires fresh modification for repo-relative paths (issue #1, bug 4)

**Files:**
- Modify: `src/contracts.ts`, `src/scheduler.ts` (pass dispatch timestamp).
- Test: `test/contracts.test.ts`.

**Interfaces:**
- Produces: `verifyOutputs(opts: { workerDir: string; repoCwd: string; outputs: ContractOutput[]; notBeforeMs?: number }): Promise<ContractResult>` — new optional field, all existing callers unaffected.

- [ ] **Step 1: Write failing tests** in `test/contracts.test.ts`:

```typescript
it("fails file-exists for a repo-relative file untouched since notBeforeMs", async () => {
  // tmp repo dir; write src/x.ts; set its mtime to 1 hour ago (fs.utimes);
  // verifyOutputs({ ..., outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], notBeforeMs: Date.now() })
  // => check ok === false, error mentions "not modified"
});

it("passes file-exists for a repo-relative file modified after notBeforeMs", async () => {
  // same but write the file after capturing notBeforeMs => ok === true
});

it("ignores notBeforeMs for output/ paths", async () => {
  // output/x.md under workerDir written long ago still passes file-exists
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `src/contracts.ts`: thread `notBeforeMs` through `verifyOutputs` → `checkOne`. In `checkOne`'s `file-exists` branch:

```typescript
    if (o.kind === "file-exists") {
      if (s.size === 0) return fail("empty file");
      const repoRelative = !isAbsolute(o.path) && !o.path.startsWith("output/");
      if (repoRelative && notBeforeMs !== undefined && s.mtimeMs < notBeforeMs) {
        return fail("pre-existing repo file not modified since worker start");
      }
      return { ...base, ok: true };
    }
```

`src/scheduler.ts`: capture `const dispatchMs = Date.now();` immediately before `await patch(w.id, { status: "running", started_at: ... })`, and pass `notBeforeMs: dispatchMs` in the `verifyOutputs({...})` call.

- [ ] **Step 4:** Tests PASS, `npm test` green, tsc clean.
- [ ] **Step 5:** Commit `fix(fleet): file-exists contract checks freshness for repo-relative paths (issue #1 bug 4)`

---

### Task 5: Surface unknown-pricing zero cost (issue #1, bug 5)

**Files:**
- Modify: `src/scheduler.ts` (completion patch `status_note`).
- Test: `test/scheduler-cost.test.ts`.

- [ ] **Step 1: Write failing tests** in `test/scheduler-cost.test.ts` (read it first, follow its spawn-fake conventions):

```typescript
it("notes when tokens were consumed but cost stayed zero (unknown pricing)", async () => {
  // spawn returns { ok: true, turns: 2, tokens: 44000, cost: 0 }; node completes
  // expect state.nodes.<id>.status_note to match /cost .*unavailable|no pricing/i
});

it("adds no note when cost is positive", async () => {
  // spawn returns cost: 0.5 => status_note undefined
});

it("adds no note when tokens are zero", async () => {
  // spawn returns tokens: 0, cost: 0 => status_note undefined
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** In `src/scheduler.ts` where the completion `patch` is built (after `verifyOutputs`):

```typescript
          const costUnknown = res.tokens > 0 && (res.cost ?? 0) === 0;
          const costNote = costUnknown ? `cost unavailable: no pricing for model (${res.tokens} tokens used)` : undefined;
          await patch(w.id, {
            status: contract.ok ? "completed" : "contract_failed",
            ended_at: new Date().toISOString(),
            turns: res.turns,
            tokens: res.tokens,
            cost_usd_estimate: res.cost ?? 0,
            contract_result: contract,
            produced_outputs: contract.checks.filter((c) => c.ok || c.actualPath).map((c) => c.path),
            status_note: contract.ok ? costNote : [contractFailureNote(contract.checks), costNote].filter(Boolean).join(" · "),
          });
```

- [ ] **Step 4:** Tests PASS, `npm test` green, tsc clean.
- [ ] **Step 5:** Commit `fix(fleet): note unknown-pricing zero cost on completed nodes (issue #1 bug 5)`

---

### Task 6: Canvas top-down DAG layout (issue #2, item 2)

**Files:**
- Create: `src/canvas-layout.ts`
- Modify: `src/canvas-client.tsx` (import layout, TD handles)
- Test: `test/canvas-layout.test.ts` (new)

**Interfaces:**
- Produces (from `src/canvas-layout.ts`):

```typescript
export const NODE_W = 284;
export const NODE_H_GAP = 200; // vertical distance between layers
export const NODE_W_GAP = 40;  // horizontal gap between same-layer nodes
export function topoLayers(ids: string[], edges: Array<{ from: string; to: string }>): string[][];
export function reduceCrossings(layers: string[][], edges: Array<{ from: string; to: string }>): string[][];
export function computePositions(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
): Record<string, { x: number; y: number }>;
```

`computePositions` is top-down: layer `li` gets `y = li * NODE_H_GAP`; within a layer, node `ni` gets `x = xOffset + ni * (NODE_W + NODE_W_GAP)` where `xOffset = (maxLayerLen - layer.length) * (NODE_W + NODE_W_GAP) / 2` (centers narrow layers under wide ones).

- [ ] **Step 1: Write failing tests** `test/canvas-layout.test.ts`:

```typescript
// issue #2 example DAG: A,B -> C ; B -> D ; C -> D ; A,B,C,D -> E
const ids = ["A", "B", "C", "D", "E"];
const edges = [
  { from: "A", to: "C" }, { from: "B", to: "C" }, { from: "B", to: "D" },
  { from: "C", to: "D" }, { from: "A", to: "E" }, { from: "B", to: "E" },
  { from: "C", to: "E" }, { from: "D", to: "E" },
];

it("stacks layers vertically: deeper nodes have strictly larger y", () => {
  const pos = computePositions(ids.map((id) => ({ id })), edges);
  expect(pos.A.y).toBe(0);
  expect(pos.C.y).toBeGreaterThan(pos.A.y);
  expect(pos.D.y).toBeGreaterThan(pos.C.y);
  expect(pos.E.y).toBeGreaterThan(pos.D.y);
});

it("gives same-layer nodes distinct x positions", () => {
  const pos = computePositions(ids.map((id) => ({ id })), edges);
  expect(pos.A.x).not.toBe(pos.B.x);
});

it("keeps every node below all of its parents", () => {
  const pos = computePositions(ids.map((id) => ({ id })), edges);
  for (const e of edges) expect(pos[e.to].y).toBeGreaterThan(pos[e.from].y);
});

it("centers narrow layers horizontally under the widest layer", () => {
  const pos = computePositions(ids.map((id) => ({ id })), edges);
  // E is alone in the deepest layer => centered: x > 0
  expect(pos.E.x).toBeGreaterThan(0);
});

it("is deterministic across calls", () => {
  const a = computePositions(ids.map((id) => ({ id })), edges);
  const b = computePositions(ids.map((id) => ({ id })), edges);
  expect(a).toEqual(b);
});
```

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3: Implement** `src/canvas-layout.ts` — move `topoLayers`/`reduceCrossings` from `canvas-client.tsx` (signature change: `topoLayers` takes `ids: string[]` instead of node views; adjust the one caller), implement TD `computePositions` per the interface above. Then `canvas-client.tsx`:

```typescript
import { computePositions, NODE_W } from "./canvas-layout";
```

(delete local `topoLayers`/`reduceCrossings`/`computePositions`/`median` and the local `const NODE_W = 284;`; the `computePositions(payload)` call site becomes `computePositions(payload.nodes, payload.edges)`.)

Change `FleetNode` handles for top-down flow:

```tsx
      <Handle type="target" position={Position.Top} />
      <Handle type="target" position={Position.Top} id="loopIn" />
      ...
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" position={Position.Bottom} id="loop" />
```

- [ ] **Step 4:** `npx vitest run test/canvas-layout.test.ts` PASS → `npm test` green → tsc clean. Also run `npx vitest run test/canvas.test.ts` — `renderCanvasPage` still bundles the client without error (esbuild resolves the new import).
- [ ] **Step 5:** Commit `fix(canvas): deterministic top-down layered DAG layout (issue #2 item 2)`

---

### Task 7: Canvas copyable errors, tucked instructions, dense cards (issue #2, items 1, 3, 4)

**Files:**
- Modify: `src/canvas.ts` (CSS in the HTML template; esbuild build options), `src/canvas-client.tsx`, `src/canvas-layout.ts` (add `excerptText` helper — it is the pure-logic home).
- Test: `test/canvas.test.ts`, `test/canvas-layout.test.ts`.

**Interfaces:**
- Produces: `export function excerptText(text: string, max: number): { excerpt: string; truncated: boolean }` in `src/canvas-layout.ts`.

**Sub-item A — copyable error text (issue #2 item 1):**

- [ ] **Step 1: Failing tests:**

```typescript
// test/canvas-layout.test.ts
it("excerptText truncates long text with ellipsis marker", () => {
  const r = excerptText("x".repeat(500), 240);
  expect(r.truncated).toBe(true);
  expect(r.excerpt.length).toBeLessThanOrEqual(241); // 240 + ellipsis char
});
it("excerptText passes short text through", () => {
  expect(excerptText("short", 240)).toEqual({ excerpt: "short", truncated: false });
});

// test/canvas.test.ts (renderCanvasPage describe)
it("ships selectable error CSS and nodrag hooks", async () => {
  const html = await renderCanvasPage();
  expect(html).toContain("user-select:text");
  expect(html).toContain("nodrag");
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - `src/canvas-layout.ts`: add `excerptText` (`truncated = text.length > max`; `excerpt = truncated ? text.slice(0, max) + "…" : text`).
  - `src/canvas.ts` CSS: add rules `.note, .fail-reason { user-select:text; cursor:text; }` and `.activity-body, .timeline-text, .action-detail { user-select:text; }` (append near the existing `.note` rule at ~line 728). If the esbuild call in `startCanvasServer`/`renderCanvasPage` minifies, set `minify: false` (local tool; readability beats bytes) so `nodrag` survives in the bundle for the test.
  - `src/canvas-client.tsx`: add `nodrag` to the note/fail-reason divs: `<div className="note nodrag">`, `<div className="fail-reason nodrag">`.

**Sub-item B — instructions panel tucked away (issue #2 item 3):**

- [ ] **Step 4: Implement** (covered by sub-item A test run for regressions; behavior verified in Task 8 smoke): in `canvas-client.tsx` `CollapsiblePrompt`, default `useState(false)` (collapsed). In `SidePanel`, move `<CollapsiblePrompt ... />` to render AFTER `<Timeline ... />` (bottom of `.side-body`), and change its title to `"Instructions (task prompt)"`.

**Sub-item C — dense assistant cards (issue #2 item 4):**

- [ ] **Step 5: Implement** in `TimelineItem`'s `message` branch: assistant/user text uses `excerptText(event.text, 240)`; when truncated, render excerpt + a `show more` / `show less` toggle button (local `useState`). CSS in `canvas.ts`: denser message rows — `.timeline-msg { padding:4px 8px; } .timeline-text { font-size:12px; line-height:1.45; white-space:pre-wrap; }` (adjust existing rules, don't duplicate).

- [ ] **Step 6:** `npm test` green, tsc clean.
- [ ] **Step 7:** Commit `fix(canvas): copyable errors, tucked instructions, dense cards (issue #2 items 1,3,4)`

---

### Task 8: Live smoke — dead-simple fleet, minimal tokens

**Files:**
- Create: `docs/experiments/001-fleet-extension-impl/findings/04-issues-1-2-smoke.md`

**Method (matches earlier fleet testing — see `docs/experiments/001-fleet-extension-impl/findings/01-loop-smoke-results.md`):** headless pi loading the dev extension from the worktree:

```bash
cd <worktree> && pi -ne -e ./src/index.ts --model openai-codex/gpt-5.4 -p "<driver prompt>"
```

Driver prompt instructs the headless agent to (exact fleet JSON provided inline in the prompt):

1. `fleet_plan` fleet `issue1-smoke` with `config: { max_concurrent: 2, model: "openai-codex/gpt-5.4-mini" }` and workers:
   - `slow`: task `Write output/slow.md containing '# 789' on the first line, then the numbers 1 to 300 each on their own line.` outputs `[{path: "output/slow.md", kind: "markdown", required: true}]`
   - `failer`: task `Reply with exactly the text OK. Do not write any files.` outputs `[{path: "output/need.md", kind: "markdown", required: true}]` (will contract-fail)
   - `downstream`: task `This task will be replaced.` depends_on `["failer"]`, outputs `[{path: "output/down.md", kind: "markdown", required: true}]`
2. `fleet_launch` with `skip_confirm: true`.
3. Poll `fleet_status` until `failer` is `contract_failed` and `downstream` is `blocked` while `slow` still runs.
4. While running: `fleet_edit` node `downstream` key `task` value `Write output/down.md containing '# done'.` (bug 3 check — must succeed), then `fleet_relaunch` node `failer` (bug 2 check — must return a queued/dispatch message, NOT `fleet is running`).
5. Poll until fleet ends. Report final per-node statuses.
6. Expected: `failer` re-dispatched (it may contract-fail again — acceptable, the re-dispatch is the fix under test), `downstream` runs with the edited task and completes, `slow` completes.
7. Also `fleet_kill` a blocked node variant is covered by unit tests; skip live to save tokens.

- [ ] **Step 1:** Run the headless smoke; capture the agent's final report.
- [ ] **Step 2:** Verify on disk (cheap, no tokens): `jq '.nodes | map_values(.status)' <worktree>/.fleet/issue1-smoke-*/state.json`, `grep -l "PRE-APPROVED" <worktree>/.fleet/issue1-smoke-*/workers/*/prompt.md` (bug 1 check — preamble present in every prompt).
- [ ] **Step 3:** Write findings doc `04-issues-1-2-smoke.md` (setup, driver prompt, results, token totals from state.json).
- [ ] **Step 4:** Commit `docs(findings): issue 1+2 live smoke results`

---

### Task 9: Wrap-up docs

**Files:**
- Modify: `todo.md` (append closed items)
- Create: `docs/experiments/001-fleet-extension-impl/checkpoints/08-issues-1-2-fixed.md`

- [ ] **Step 1:** Write checkpoint doc: what shipped per bug/item, test counts, smoke results, parked minors.
- [ ] **Step 2:** Append to `todo.md` under a new `## Issue fixes (gh #1 #2)` section: 9 checked items.
- [ ] **Step 3:** Commit `docs(ckpt): gh issues 1+2 fixed`

---

## Self-Review Notes

- Spec coverage: issue #1 bugs 1→Task 1, 2→Task 2, 3→Task 3, 4→Task 4, 5→Task 5. Issue #2 items 1,3,4→Task 7, item 2→Task 6. Live verification→Task 8. Docs→Task 9. WIP baseline→Task 0.
- Task 2 and Task 3 both touch `src/scheduler.ts` (different regions: top-of-pass relaunch block vs pre-dispatch kill block) and `src/controller.ts` (different functions) — sequenced, not parallel.
- `patchNode` spreads partials; `undefined` values overwrite keys and `JSON.stringify` drops them — safe for the Task 2 reset patch.
