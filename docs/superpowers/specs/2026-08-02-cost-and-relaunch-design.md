# Worker cost plumbing + node relaunch (v2.1)

**Date:** 2026-08-02
**Status:** Approved by user directive (autonomous build)
**Repo:** `pi-fleet-extension`, extends loop fleets v2
**Execution:** dogfooded — built by an iterative loop fleet running on the extension itself

## 1. Scope

Two features:

- **A. Real cost tracking** — pipe pi-ai's per-message `usage.cost.total` through runner → state → widget/report; fix fleet-cost accumulation across iterations; activate `warn_cost_usd`
- **B. Node relaunch with model override** — `fleet_relaunch` tool + `/fleet relaunch` command; rerun a failed node (optionally with a different model) and its blocked downstream, without re-running completed work

Non-goals: dead-session recovery, plateau search, single-node kill (relaunch ≠ kill), JIT nodes.

## 2. Feature A: cost plumbing

**Key fact:** pi-ai assistant messages carry `usage.cost: { input, output, cacheRead, cacheWrite, total }` (dollars), computed from `Model.cost` in pi's model registry. No pricing table in the extension. If a model lacks cost data, totals stay 0 — acceptable.

### Changes

1. **runner.ts** — where `usage.totalTokens` is accumulated, also accumulate `usage.cost?.total ?? 0`. New event `{ type: "cost"; nodeId: string; cost: number }` emitted alongside tokens events. `RunWorkerResult` gains `cost: number` on both ok and error paths.
2. **scheduler.ts** — `SpawnFn` return type gains `cost: number`. On spawn completion, node patch includes `cost_usd_estimate: res.cost`.
3. **index.ts** — spawn `onEvent` handles `cost`: patch node `cost_usd_estimate` live. After each patch, if `spec.config.warn_cost_usd` set and fleet cumulative cost ≥ warn and not yet warned → `ctx.ui.notify("fleet cost warning: $<cost> >= $<warn>", "warning")` once (flag on ActiveFleet).
4. **state.ts — fleet cost accumulation fix.** `patchNode` and `resetForIteration` currently recompute fleet cost from live `nodes` only — iterations' costs are dropped on reset. Fix: fleet cost = sum of live node costs + sum of all `iterations[].nodes` costs. Implement one helper `fleetCost(state): number` used by both.
5. **report.ts / ui.ts** — no changes (fields already rendered; they become real).

### Semantics

- Costs are per-worker-session; replay nodes accrue per-iteration cost inside that iteration's snapshot; fleet total accumulates across iterations via the helper.
- `warn_cost_usd` is warning-only (v1 decision stands); it now actually fires.

## 3. Feature B: node relaunch

### Surface

- Tool `fleet_relaunch { node_id: string, model?: string }`
- Command `/fleet relaunch <node_id> [model]`
- `fleet_kill` unchanged (fleet-wide only)

### Guards (all hard errors with clear text)

1. Active fleet exists and `running === false` (fleet status `failed`, `paused`, or `killed`; `completed` → "fleet completed, nothing to relaunch")
2. `node_id` exists in spec
3. Node status ∈ {`failed`, `contract_failed`, `killed`} — relaunching `completed`/`blocked` directly is rejected (blocked nodes are reset transitively, see below)

### Reset semantics (state.ts, pure, tested)

`resetForRelaunch(state: FleetState, spec: FleetSpec, nodeId: string): FleetState`

- Target node → fresh NodeState (`status: "pending"`, zeroed counters, no contract_result/status_note)
- Every transitively dependent node with status `blocked` → fresh pending NodeState (walk `depends_on` graph downstream from target)
- All other nodes untouched (completed stay completed; run-once/replay flags irrelevant here)
- `state.paused` → false; `status` → "running" happens at runFleet resume, not here

### Model override

- `model` param → resolve via existing `resolveModelReference`; unresolvable → error, nothing changes
- On success: update in-memory `spec.workers[i].model = "<provider>/<id>"` AND rewrite `fleet.json` on disk (durable record)

### Scheduler: continue-pass mode

`RunFleetOpts` gains `continuePass?: boolean`. With `resumeFrom`:

- current behavior: if all nodes terminal → `resetForIteration` + clean outputs (loop boundary semantics). Correct for `fleet_resume`
- with `continuePass: true`: skip that reset entirely — inner loop simply dispatches whatever is `pending` (the relaunched node + unblocked dependents). Loop fleets: when the pass reaches all-terminal, the normal boundary machinery (snapshot, gate, next iteration) proceeds. One-shot fleets: pass completes → final status recompute per existing v1 rules
- `fleet_relaunch` calls runFleet with `resumeFrom: <patched state>` + `continuePass: true`, reusing the `startLoop` wiring (prompts regenerated via `prepareIteration`)

## 4. Testing (zero-API)

- runner: fake session emitting assistant messages with `usage.cost.total` → result.cost summed; missing cost → 0
- state: `fleetCost` accumulation across reset; `resetForRelaunch` (target reset, transitive blocked reset, completed untouched, wrong-status rejection)
- scheduler: SpawnFn with cost → node patched; `continuePass` one-shot resume does NOT re-run completed nodes; loop fleet continuePass → gate still evaluated at boundary
- dag/validation: none (no schema change)
- index: tsc + live smoke only (no harness)

## 5. Live smoke (end of build)

Fleet: writer with deliberate bogus `model: "no-such-model"` → node fails at spawn → `fleet_relaunch writer gpt-5.4-mini` → fleet completes. Verify: real `$` amounts > 0 in state/report; relaunch recorded in fleet.json. Trivial tasks (123/456 style), gpt-5.4-mini.

## 6. Dogfood execution fleet

Built by loop fleet on the extension itself:

- `builder-pricing` (code-run, gpt-5.5): Feature A per this spec §2
- `builder-relaunch` (code-run, gpt-5.5, depends_on builder-pricing): Feature B per §3
- `reviewer` (reviewer, k3, depends_on both): reads `git diff`, builder test evidence, spec; verdict contract
- loop: `gate: reviewer, max_iterations: 3, lgtm_count: 1`
- Builders must run `npx vitest run` + `npx tsc --noEmit` and paste tails into `output/tests.txt` (markdown contract)
- Sequential builders (shared repo); controller (main session) does final verification + smoke + docs
