# Loop Fleets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reviewer-gated and free-running iteration loops, run-once/replay nodes, pause/resume, and per-node worktree directives to the fleet extension, per spec.

**Architecture:** Outer iteration loop around the existing v1 scheduler inner loop; gate decision at iteration boundary from the reviewer node's verdict contract; all feedback flows through regenerated prompts; extension runs zero git commands.

**Spec:** `docs/superpowers/specs/2026-08-01-loop-fleets-design.md` (read sections referenced per task)

**Tech Stack:** TypeScript ESM, vitest, typebox, pi SDK. Zero-API tests via fake spawn/SessionFactory.

## Global Constraints

- Commit ontology: `<type>: <imperative summary>` — types: `add:` `update:` `fix:` `spec:` `test:` `refactor:` — lowercase after prefix, ≤72 chars
- `config.loop` absent → v1 one-shot behavior byte-identical (all 33 existing tests must keep passing unmodified)
- No sentinel files; pause is a `state.json` field
- Extension runs zero git commands (worktree = prompt injection only)
- Contract checks at worker exit only; gate decisions at iteration boundary only
- `tsc` clean (`npm run typecheck` if present, else `npx tsc --noEmit`) and `npx vitest run` green after every task
- Verdict regex already exists in contracts.ts: `/^verdict:\s*(lgtm|iterate|escalate)\s*$/m`
- Repo: `/Users/sagar/work/pi-fleet-extension`, work directly on `main`, push as you go

---

### Task 1: Types + ontology

**Files:**
- Modify: `src/types.ts`
- Modify: `docs/ontology.md`
- Test: `test/types.test.ts` (create)

**Interfaces:**
- Produces (everything later tasks use):
  - `GateKind = "reviewer" | "none"`
  - `Verdict = "lgtm" | "iterate" | "escalate"`
  - `LoopConfig { gate: GateKind; max_iterations: number; lgtm_count: number }`
  - `WorkerSpec` gains `iterate: boolean; worktree: boolean`
  - `FleetConfig` gains `loop?: LoopConfig`
  - `FleetStatus` gains `"paused"`
  - `ContractResult` gains `verdict?: Verdict; verdict_body?: string`
  - `IterationSnapshot { n: number; verdict: Verdict | null; verdict_body: string | null; started_at: string; ended_at: string; nodes: Record<string, NodeState> }`
  - `FleetState` gains `iteration: number; lgtm_streak: number; paused: boolean; iterations: IterationSnapshot[]`

- [ ] **Step 1: Write failing test** — `test/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TERMINAL_NODE_STATUSES } from "../src/types.js";
import type { FleetSpec, FleetState, IterationSnapshot, LoopConfig } from "../src/types.js";

describe("loop fleet types", () => {
  it("LoopConfig accepts reviewer gate", () => {
    const loop: LoopConfig = { gate: "reviewer", max_iterations: 5, lgtm_count: 2 };
    expect(loop.lgtm_count).toBe(2);
  });

  it("FleetSpec carries loop config and per-node flags", () => {
    const spec: FleetSpec = {
      fleet_name: "t", type: "dag",
      config: { max_concurrent: 1, model: "m", loop: { gate: "none", max_iterations: 3, lgtm_count: 1 } },
      workers: [{ id: "a", type: "write", task: "t", depends_on: [], outputs: [], iterate: true, worktree: false }],
    };
    expect(spec.config.loop?.gate).toBe("none");
    expect(spec.workers[0].iterate).toBe(true);
  });

  it("IterationSnapshot shape", () => {
    const snap: IterationSnapshot = { n: 1, verdict: "iterate", verdict_body: "fix x", started_at: "s", ended_at: "e", nodes: {} };
    expect(snap.verdict).toBe("iterate");
  });

  it("paused is not a terminal node status concept — fleet status only", () => {
    expect(TERMINAL_NODE_STATUSES.has("killed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run `npx vitest run test/types.test.ts` — expect FAIL (missing exports/fields)**

- [ ] **Step 3: Implement in `src/types.ts`**

```ts
export type GateKind = "reviewer" | "none";
export type Verdict = "lgtm" | "iterate" | "escalate";

export interface LoopConfig {
  gate: GateKind;
  max_iterations: number;
  lgtm_count: number;
}
```

Add to `WorkerSpec`: `iterate: boolean;` and `worktree: boolean;`
Add to `FleetConfig`: `loop?: LoopConfig;`
Change `FleetStatus` to: `"planned" | "running" | "paused" | "completed" | "failed" | "killed"`
Add to `ContractResult`: `verdict?: Verdict;` and `verdict_body?: string;`

```ts
export interface IterationSnapshot {
  n: number;
  verdict: Verdict | null;
  verdict_body: string | null;
  started_at: string;
  ended_at: string;
  nodes: Record<string, NodeState>;
}
```

Add to `FleetState`: `iteration: number; lgtm_streak: number; paused: boolean; iterations: IterationSnapshot[];`

NOTE: `initFleetState` in `src/state.ts` constructs `FleetState` — it will fail to compile until Task 4. For this task, patch `initFleetState` minimally: add `iteration: 1, lgtm_streak: 0, paused: false, iterations: []` to the object it returns. Do NOT touch anything else in state.ts.

- [ ] **Step 4: Append ontology terms** — end of `docs/ontology.md`, before the commit-ontology section, new table:

```markdown
## Loop terms (v2)

| term | definition |
|---|---|
| **iteration** | one full DAG pass in a loop fleet |
| **loop** | `config.loop` block — turns one-shot DAG into gated replay |
| **gate** | loop decision mechanism: `reviewer` \| `none` |
| **lgtm streak** | consecutive `lgtm` verdicts; resets on `iterate`; loop stops at `lgtm_count` |
| **replay node** | `iterate: true` (default) — fresh session each iteration |
| **run-once node** | `iterate: false` — runs at iteration 1 only; outputs carry over |
| **feedback injection** | prior-iteration review body appended to replay-node prompts |
| **review history** | all prior verdicts+bodies injected into reviewer prompt |
| **iteration boundary** | point between all-terminal DAG and next pass — only place gate/pause decisions happen |
| **paused** | resumable non-terminal fleet status: `planned → running ⇄ paused → completed\|failed\|killed` |
| **escalate** | verdict → auto-pause + operator notify |
| **worktree directive** | prompt-injected instruction: node creates own worktree at designated path/branch |
| **fleet branch** | `fleet/<fleet-ts>/<node-id>` naming convention |
| **resolver node** | DAG node whose task is merging conflicting upstream worktrees (convention, not machinery) |
```

Also update the reserved-terms table: remove the `iteration` row (now defined above). Keep `JIT node` reserved.

- [ ] **Step 5: Run `npx vitest run` (full) + `npx tsc --noEmit` — all green**

- [ ] **Step 6: Commit** — two commits: `add: loop fleet types (gate, verdict, iteration snapshot)` then `update: activate loop terms in ontology`

---

### Task 2: Loop validation (dag.ts)

**Files:**
- Modify: `src/dag.ts`
- Test: `test/dag-loop.test.ts` (create)

**Interfaces:**
- Consumes: types from Task 1
- Produces: `validateFleetSpec` continues returning `{ ok: true, spec, layers } | { ok: false, errors }`; on success `spec` has defaults applied: every worker gets `iterate` (default `true`) and `worktree` (default `false`); `config.loop.lgtm_count` defaults to `1` when `gate: "reviewer"` and unset

Read `src/dag.ts` first to match existing validation style. Rules (spec §4):

1. `loop.max_iterations`: required when `loop` present, integer ≥ 1
2. `loop.gate`: required when `loop` present, must be `"reviewer" | "none"`
3. `loop.lgtm_count`: if present must be integer ≥ 1; rejected when `gate: "none"`
4. `gate: "reviewer"`: exactly one node with a `verdict`-kind output; that node must have `iterate !== false` and must be a sink (no other node lists it in `depends_on`)
5. `iterate: false` node may not appear in any `iterate !== false` node's `depends_on`... NO — precise rule: a run-once node may not depend on a replay node. For every worker W with `iterate === false`, every id in `W.depends_on` must resolve to a worker that also has `iterate === false`
6. `loop` absent → skip rules 1-5 entirely (v1 behavior)

Error strings: prefix each with rule context, e.g. `"loop.max_iterations must be an integer >= 1"`, `"gate reviewer requires exactly one verdict-output node, found 2"`, `"run-once node \"a\" depends on replay node \"b\""`.

- [ ] **Step 1: Write failing tests** — `test/dag-loop.test.ts`. Cover: (a) valid reviewer-gate spec passes with defaults applied; (b) max_iterations 0 → error; (c) loop without gate → error; (d) lgtm_count with gate none → error; (e) two verdict nodes → error; (f) verdict node with dependent → error; (g) verdict node `iterate: false` → error; (h) run-once depending on replay → error; (i) replay depending on run-once → OK; (j) gate none valid spec passes; (k) no loop → `iterate`/`worktree` defaults still applied, no loop errors. Helper to build a base spec:

```ts
import { describe, expect, it } from "vitest";
import { validateFleetSpec } from "../src/dag.js";

function baseSpec(over: Record<string, unknown> = {}) {
  return {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1, model: "m", ...(over.config as object ?? {}) },
    workers: over.workers ?? [
      { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      { id: "r", type: "reviewer", task: "t", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
    ],
  };
}

describe("loop validation", () => {
  it("valid reviewer gate gets defaults", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } } }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.spec.config.loop?.lgtm_count).toBe(1);
      expect(v.spec.workers.every((w) => w.iterate === true && w.worktree === false)).toBe(true);
    }
  });
  it("rejects max_iterations 0", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 0 } } }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/max_iterations/);
  });
  // ... cases (c) through (k) per list above, same pattern
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement rules + defaults in `validateFleetSpec`** (apply defaults early, then validate). Run-once-dependency rule implementation sketch:

```ts
const byId = new Map(spec.workers.map((w) => [w.id, w]));
for (const w of spec.workers) {
  if (w.iterate !== false) continue;
  for (const d of w.depends_on) {
    const dep = byId.get(d);
    if (dep && dep.iterate !== false) errors.push(`run-once node "${w.id}" depends on replay node "${d}"`);
  }
}
```

- [ ] **Step 4: Full suite + tsc green**
- [ ] **Step 5: Commit** — `add: loop config validation and per-node flag defaults`

---

### Task 3: Contracts — verdict extraction + worktree repoCwd

**Files:**
- Modify: `src/contracts.ts`
- Test: `test/contracts-loop.test.ts` (create)

**Interfaces:**
- Consumes: `Verdict`, `ContractResult.verdict`/`verdict_body` from Task 1
- Produces: `verifyOutputs(opts)` — same signature (`{ workerDir, repoCwd, outputs }`); result now carries `verdict` + `verdict_body` parsed from the first passing verdict-kind check. Callers pass the node's worktree dir as `repoCwd` for worktree nodes (no signature change needed — scheduler's job, Task 5)

- [ ] **Step 1: Failing test** — verdict file `verdict: iterate\n\n## builder-a\n1. fix the thing` in a temp workerDir → result `{ ok: true, verdict: "iterate", verdict_body: "## builder-a\n1. fix the thing" }`. Also: verdict file with only whitespace body → `ok: false` (v1 behavior kept), `verdict` undefined. Non-verdict fleet → `verdict` undefined.

```ts
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyOutputs } from "../src/contracts.js";

async function fixture(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-c-"));
  await mkdir(join(dir, "output"), { recursive: true });
  await writeFile(join(dir, "output", "review.md"), content, "utf-8");
  return dir;
}

describe("verdict extraction", () => {
  it("extracts verdict and body", async () => {
    const dir = await fixture("verdict: iterate\n\n## builder-a\n1. fix the thing\n");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/review.md", kind: "verdict", required: true }] });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("iterate");
    expect(r.verdict_body).toContain("fix the thing");
  });
  it("verdict-only file fails, no verdict extracted", async () => {
    const dir = await fixture("verdict: lgtm\n");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/review.md", kind: "verdict", required: true }] });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — in `contracts.ts`, export `VERDICT_RE` if not already; in `verifyOutputs`, after checks: find first check with `kind === "verdict" && c.ok`, re-read that file, match `VERDICT_RE`, set `verdict = m[1] as Verdict`, `verdict_body = content.slice(content.indexOf(m[0]) + m[0].length).trim()`.
- [ ] **Step 4: Full suite + tsc green**
- [ ] **Step 5: Commit** — `add: verdict and body extraction in contract results`

---

### Task 4: State — snapshots, pause, streak, archive

**Files:**
- Modify: `src/state.ts`
- Test: `test/state-loop.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 types
- Produces:
  - `initFleetState(spec)` — already patched in Task 1; verify it inits `iteration: 1, lgtm_streak: 0, paused: false, iterations: []`
  - `snapshotIteration(state: FleetState, verdict: Verdict | null, verdictBody: string | null): FleetState` — pure; appends `{ n: state.iteration, verdict, verdict_body, started_at, ended_at: now, nodes: structuredClone(state.nodes) }` to `iterations`. `started_at` = earliest `started_at` across nodes (fallback: now)
  - `advanceIteration(state: FleetState): FleetState` — pure; `iteration + 1`; resets every replay node (worker list NOT in state — see below) — REVISED: reset needs the spec, so signature is `resetForIteration(state, spec): FleetState` returning state with each `iterate !== false` node replaced by a fresh NodeState (`{ status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] }`), run-once nodes untouched
  - `archiveIteration(fleetRoot: string, n: number, nodeIds: string[]): Promise<void>` — copies `workers/<id>/output` → `iterations/<n>/workers/<id>/output` and `workers/<id>/prompt.md` → `iterations/<n>/workers/<id>-prompt.md` for each id; `fs.cp(src, dest, { recursive: true })`, ignore missing prompt.md

- [ ] **Step 1: Failing tests** — `test/state-loop.test.ts`:

```ts
// snapshot appends with correct n, verdict, cloned nodes (mutating original after snapshot does not affect snapshot)
// resetForIteration resets replay nodes, keeps run-once completed status + contract_result
// advance: resetForIteration bumps state.iteration by 1
// archiveIteration copies output dir and prompt.md (use mkdtemp fleet root with workers/a/output/x.txt + workers/a/prompt.md)
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** (pure functions + one fs function; follow existing `patchNode` purity style — read `src/state.ts` first)
- [ ] **Step 4: Full suite + tsc green**
- [ ] **Step 5: Commit** — `add: iteration snapshots, reset, and archive in state`

---

### Task 5: Scheduler loop + gate

**Files:**
- Modify: `src/scheduler.ts`
- Test: `test/scheduler-loop.test.ts` (create)

**Interfaces:**
- Consumes: all Task 1-4 interfaces
- Produces:
  - `RunFleetOpts` gains: `pauseSwitch?: { paused: boolean }`, `resumeFrom?: FleetState`, `onIterationEnd?: (snap: IterationSnapshot) => void`, `prepareIteration?: (n: number, state: FleetState) => Promise<void>`; `repoCwd` type widens to `string | ((nodeId: string) => string)` — scheduler resolves it per node wherever repoCwd is used today (contract check)
  - `runFleet(opts)` behavior per spec §5 (pseudocode there is normative)

Key logic:

```ts
const reviewerId = spec.config.loop?.gate === "reviewer"
  ? spec.workers.find((w) => w.outputs.some((o) => o.kind === "verdict"))?.id
  : undefined;
```

Outer loop `for n from state.iteration to max_iterations`: boundary checks `pauseSwitch?.paused || state.paused` → set `status: "paused"`, `paused: true`, write, return. If `n > initialIteration` or resume: `state = resetForIteration(state, spec)`, write. Call `prepareIteration?.(n, state)`. Run existing v1 inner loop **extracted into an inner function `runPass()`** (current while-loop body, unchanged semantics). After all-terminal: compute verdict from `state.nodes[reviewerId]?.contract_result` when reviewer gate. `state = snapshotIteration(state, verdict, verdictBody)`; `onIterationEnd?.(snap)`; `await archiveIteration(fleetRoot, n, spec.workers.map(w => w.id))`. Then terminal decisions per spec §5: killed → `killed`; any failed/contract_failed → `failed`; reviewer contract_failed (reviewer node status === "contract_failed") → `failed`; `lgtm` → streak+1, `state.lgtm_streak`, `>= lgtm_count` → `completed`, return; `iterate` → streak 0, continue; `escalate` → `status: "paused"`, `paused: true`, return; gate none → continue. Loop exhausted → `failed` (both gates). Every state transition writes state (existing `writeState`).

When `config.loop` absent: exactly the v1 path (single pass, no snapshots, no archive) — guard with `if (!spec.config.loop) { ...existing behavior... }`.

`resumeFrom`: when present, skip `initFleetState`, use it as `state`, start loop at `state.iteration`, set `paused: false`, `status: "running"`.

- [ ] **Step 1: Failing tests** — fake spawn:

```ts
// helper: spec with builder b + reviewer r, loop { gate: "reviewer", max_iterations: 3, lgtm_count: 2 }
// spawn returns { ok: true, turns: 1, tokens: 10 }; reviewer verdicts scripted per iteration
// via a queue: each spawn of "r" shifts next verdict; workerDir fixture: pre-write output files
// (builder output + review.md with scripted verdict) into a mkdtemp fleetRoot before each pass —
// simplest: spawn writes the files itself (it gets nodeId; closure knows fleetRoot + verdict queue)

it("lgtm streak reaches lgtm_count → completed", async () => { /* verdicts: lgtm, lgtm → status completed, streak 2, iterations.length 2 */ });
it("iterate resets streak", async () => { /* verdicts: lgtm, iterate, lgtm, lgtm, max_iterations 4 → completed, streak 2 */ });
it("escalate → paused, streak preserved", async () => { /* verdicts: lgtm, escalate → status paused, paused true, streak 1 */ });
it("max_iterations exhausted → failed", async () => { /* all iterate, max 2 → failed, iterations.length 2 */ });
it("run-once node not re-run: spawn count for run-once id stays 1 across 2 iterations", async () => { /* iterate:false builder */ });
it("pauseSwitch at boundary → paused", async () => { /* set paused=true after first onIterationEnd → status paused */ });
it("kill mid-iteration archives partial snapshot and ends killed", async () => { /* killSwitch killed during pass 2 */ });
it("reviewer contract_failed → fleet failed", async () => { /* reviewer spawn writes no verdict file */ });
it("gate none loops until max_iterations then failed", async () => { /* gate none, max 2 → failed, 2 snapshots, verdict null */ });
it("no loop config → single pass, no snapshots (v1)", async () => { /* existing behavior */ });
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — extract `runPass`, add outer loop. Keep v1 inner loop semantics byte-identical.
- [ ] **Step 4: Full suite + tsc green (all 33 v1 tests unmodified + new)**
- [ ] **Step 5: Commit** — `add: iteration loop and reviewer gate in scheduler`

---

### Task 6: Prompts — feedback, history, worktree

**Files:**
- Modify: `src/prompts.ts`
- Test: `test/prompts-loop.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 types; `buildWorkerPrompt(opts)` existing signature `{ spec, state, workerId, fleetRoot }` — UNCHANGED signature; all new data comes from `state` (`state.iteration`, `state.iterations`) and `spec` (worker flags). Fleet-ts for branch names = basename of `fleetRoot` (e.g. `my-fleet-20260801120000` → use full basename in branch: `fleet/<basename>/<node-id>`)
- Produces: prompt sections per spec §6/§7

Rules:
- `state.iteration > 1` AND worker `iterate !== false` AND last snapshot has `verdict_body` → after `## Task` block, inject `## Reviewer feedback (iteration N-1)\n\n<body>` (N = current iteration)
- Worker has verdict-kind output AND `state.iterations.length > 0` → inject `## Previous reviews` with `### Iteration <n> — verdict: <v>` + body per snapshot (verdict may be null for gate none — then skip history)
- Worker `worktree === true` → inject `## Your worktree` block (exact text from spec §7, `<fleetRoot>` and `<node-id>` and `<fleet-ts>` substituted; fleet-ts = fleetRoot basename)
- Upstream inputs section: per dep with `worktree === true`, add line `- <dep-id> worktree: <fleetRoot>/worktrees/<dep-id> (branch fleet/<fleet-ts>/<dep-id>) — merge or cherry-pick from here if you need its repo changes`

- [ ] **Step 1: Failing tests** — build spec/state fixtures in-memory (no fs):

```ts
it("iteration 1: no feedback section", () => { /* state.iteration 1 → prompt lacks "Reviewer feedback" */ });
it("iteration 2 replay node gets feedback after Task", () => { /* snapshot with verdict_body "fix x" → prompt contains "## Reviewer feedback (iteration 1)" then "fix x"; appears before "## The fleet DAG" */ });
it("run-once node gets no feedback", () => { /* iterate: false worker at iteration 2 → no feedback section */ });
it("reviewer gets previous reviews history", () => { /* two snapshots → "### Iteration 1 — verdict: iterate" and "### Iteration 2 — verdict: lgtm" with bodies */ });
it("worktree node gets directive with paths", () => { /* contains "git worktree add <root>/worktrees/w1 -b fleet/<basename>/w1" */ });
it("downstream of worktree dep sees worktree line", () => { /* upstream section contains "worktree:" line */ });
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** in `buildWorkerPrompt` (read existing function first; insert sections per rules)
- [ ] **Step 4: Full suite + tsc green**
- [ ] **Step 5: Commit** — `add: feedback injection, review history, worktree directive in prompts`

---

### Task 7: Extension wiring — tools, schema, widget, report

**Files:**
- Modify: `src/index.ts`, `src/ui.ts`, `src/report.ts`
- Test: `test/ui-loop.test.ts`, `test/report-loop.test.ts` (create)

**Interfaces:**
- Consumes: everything
- Produces:
  - TypeBox: `WorkerSchema` gains `iterate: Type.Optional(Type.Boolean())`, `worktree: Type.Optional(Type.Boolean())`; `config` gains `loop: Type.Optional(Type.Object({ gate: Type.Union([Type.Literal("reviewer"), Type.Literal("none")]), max_iterations: Type.Number(), lgtm_count: Type.Optional(Type.Number()) }))`
  - Tools `fleet_pause` / `fleet_resume` (no params); `/fleet pause` `/fleet resume` commands
  - `ActiveFleet` gains `pauseSwitch: { paused: boolean }`
  - Widget header (loop fleets): `● fleet: <name> · iteration <n>/<max> · last verdict: <v|—> · streak <s>/<c> (<done>/<total> done · $<cost>)`
  - Report (loop fleets): `## Iterations` table `| n | verdict | tokens | cost | duration |` + verdict bodies + per-iteration node statuses

index.ts wiring specifics:
- `fleet_plan`: unchanged flow; TypeBox schema passes loop config through to validation (validation from Task 2 rejects bad specs)
- `fleet_launch` spawn: for worker with `worktree === true`, pass `repoCwd: join(fleet.fleetRoot, "worktrees", nodeId)` to `runFleet`'s contract check — implement by giving the scheduler's spawn-wrapper knowledge: the contract check happens inside `runFleet` using `opts.repoCwd`; change `RunFleetOpts.repoCwd` to `repoCwd: string | ((nodeId: string) => string)`; scheduler resolves per node. In index.ts pass a function: `(nodeId) => spec.workers.find(w=>w.id===nodeId)?.worktree ? join(fleetRoot,"worktrees",nodeId) : ctx.cwd`
- `fleet_launch` passes `pauseSwitch: fleet.pauseSwitch`, and `prepareIteration: async (n, state) => { fleet.state = state; await writeWorkerPrompts(fleet); }` (prompts rewrite per iteration — Task 6 makes them iteration-aware)
- escalate → after runFleet resolves with `status: "paused"` and last verdict escalate: `ctx.ui.notify("fleet paused: reviewer escalated", "warning")`
- `fleet_pause`: `active.pauseSwitch.paused = true` → return "pause requested (takes effect at next iteration boundary)"
- `fleet_resume`: requires `active` with state `paused`; sets `pauseSwitch.paused = false`, relaunches `runFleet` with `resumeFrom: await readState(fleet.fleetRoot)` and same spawn/onNodeChange/prepareIteration wiring → return "fleet resumed". Refactor: extract the runFleet invocation + `.then` report/notify block from `fleet_launch` into a local `startLoop(fleet, ctx, resume?)` function reused by both `fleet_launch` and `fleet_resume`.
- `/fleet pause|resume` in command handler mirror the tools.

- [ ] **Step 1: Failing tests** — ui + report only (index.ts has no unit-test harness; verified via typecheck + smoke):

```ts
// test/ui-loop.test.ts
it("loop fleet header shows iteration, verdict, streak", () => { /* buildWidgetLines(specWithLoop, stateWithSnapshots)[0] contains "iteration 2/5", "last verdict: iterate", "streak 0/2" */ });
it("one-shot fleet header unchanged", () => { /* no loop → header identical to v1 format */ });
// test/report-loop.test.ts
it("report includes iterations table and verdict bodies", () => { /* writeReport with 2-snapshot state → contains "## Iterations", "| 1 | iterate |", verdict body text */ });
it("report lists worktree branches when present", () => { /* spec worker worktree:true → report contains "fleet/<basename>/<id>" — use a fleetRoot with realistic basename */ });
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** index.ts + ui.ts + report.ts changes above (read each file first; follow existing patterns)
- [ ] **Step 4: Full suite + tsc green**
- [ ] **Step 5: Commit** — two commits: `add: loop config in fleet tools, pause and resume` then `update: widget and report show iteration history`

---

### Task 8: Live smoke + docs

**Files:**
- Docs: experiment 001 finding + checkpoint (doc skill scripts)
- No source changes expected

**Interfaces:**
- Consumes: full build

- [ ] **Step 1: Run full suite + tsc — green**
- [ ] **Step 2: Live smoke** — launch pi with extension (`pi -e ./src/index.ts` or project-standard method), `fleet_plan` this exact fleet, then `fleet_launch` with `skip_confirm: true`:

```json
{
  "fleet_name": "loop-smoke",
  "type": "dag",
  "config": {
    "max_concurrent": 2,
    "model": "gpt-5.4-mini",
    "loop": { "gate": "reviewer", "max_iterations": 3, "lgtm_count": 1 }
  },
  "workers": [
    { "id": "writer-a", "type": "write", "task": "Write the text 123 into output/a.txt (via output/a.md is NOT needed — write a markdown file output/a.md whose only heading content is the number 123, e.g. '# 123').", "depends_on": [], "outputs": [{ "path": "output/a.md", "kind": "markdown", "required": true }] },
    { "id": "writer-b", "type": "write", "task": "Write a markdown file output/b.md containing '# 456'.", "depends_on": [], "outputs": [{ "path": "output/b.md", "kind": "markdown", "required": true }] },
    { "id": "reviewer", "type": "reviewer", "task": "Review output/a.md and output/b.md from upstream workers. On the FIRST review only, write verdict: iterate with body asking writer-a to also include the word 'done' in a.md. On any later review, if a.md contains 'done', write verdict: lgtm with a one-line body. Otherwise iterate again.", "depends_on": ["writer-a", "writer-b"], "outputs": [{ "path": "output/review.md", "kind": "verdict", "required": true }] }
  ]
}
```

Note: reviewer seeing prior reviews is Task 6 behavior — the reviewer's "on any later review" instruction works via injected `## Previous reviews`. If the reviewer fails to condition on history, simplify: accept lgtm-on-iteration-2 via history injection.

- [ ] **Step 3: Verify** — final state `completed`, 2 iterations, `iterations/1/workers/` archive exists, report has Iterations table, widget showed iteration header. Record actuals.
- [ ] **Step 4: Docs** — `finding.sh 1 "loop-smoke-results"` with outcome + numbers; `ckpt.sh 1 "loop fleets shipped"` with What/Why/How + next
- [ ] **Step 5: Commit** — `test: live loop smoke verified` (docs) and push

---

## Self-review notes (controller filled)

- Spec coverage: §3 schema → T1/T2/T7; §4 validation → T2; §5 scheduler → T5; §6 prompts → T6; §7 worktree → T3(repoCwd)/T6(directive)/T7(wiring); §8 pause/resume → T5(boundary)/T7(tools); §9 widget/report → T7; §12 ontology → T1; §13 testing → all + T8
- Type consistency: `snapshotIteration`, `resetForIteration`, `archiveIteration`, `prepareIteration`, `pauseSwitch`, `resumeFrom`, `repoCwd: string | ((nodeId: string) => string)` used consistently across tasks
- RepoCwd-as-function change (T7) touches scheduler signature (T5) — T5 must implement `repoCwd: string | ((nodeId: string) => string)` in RunFleetOpts from the start
