# Finding: cost plumbing + node relaunch shipped (dogfooded)

**Date:** 2026-08-02 · **Verdict:** shipped, commits `dc9291a..bcf11f7` (6), 111/111 tests, tsc clean

## What

Two features, BUILT BY THE EXTENSION ITSELF (iterative loop fleet, tmux orchestrator session, in-fleet k3 reviewer → lgtm iteration 1):

**A. Real cost tracking.** pi-ai already computes `usage.cost.total` per assistant message — runner accumulates → node cost patched live → widget/report show real dollars. `warn_cost_usd` now actually fires (once per startLoop). Fleet total accumulates across iterations.

**B. Node relaunch with model override.** `fleet_relaunch { node_id, model? }` + `/fleet relaunch`. Guards: fleet not running, node failed/contract_failed/killed. Resets target + transitive blocked dependents → pending; completed untouched. Model override resolved against pi registry (any logged-in provider), persisted to fleet.json. Scheduler `continuePass` mode resumes without replay-reset.

## Live smoke (real money, real numbers)

Bogus-model fleet: writer fails (`no-such-model-xyz`) → fleet failed → `fleet_relaunch writer gpt-5.4-mini` → completed. Node cost $0.0068 in state.json. Multi-provider confirmed: pi-logged-in providers all usable per-node.

## Outside review (k3) → fix wave

Fleet's own reviewer said lgtm; outside k3 found 3 real bugs — dogfooding lesson: in-fleet review ≠ independent review:
1. CRITICAL: relaunch of killed fleet re-killed nodes (killSwitch never cleared)
2. IMPORTANT: relaunch of paused loop fleet re-paused (pauseSwitch never cleared)
3. IMPORTANT: fleet cost double-counted across snapshots → fixed by ownership transfer: snapshots own iteration costs, live counters zeroed at snapshot (disjoint by construction)

Fix wave `eba5249`+`bcf11f7`, re-review all ADDRESSED, ship verdict.

## Parked minors

- costWarned resets per startLoop → warn can re-fire on resume (cosmetic)
- report Nodes table shows $0.00 for loop fleets post-snapshot (costs live in Iterations table; totals correct)
- one resetForIteration cost test replaced by resetForRelaunch test (minor coverage loss, misreported in fix report)

## Numbers

- Build fleet: 4.4M worker tokens, ~$2-3 est, 1 iteration, 4 commits
- Test count: 93 → 111 (+18 across cost, relaunch, scheduler)
