# cost+relaunch review fix report

## Finding 1 — relaunch of killed fleet re-kills

**Change:** In `src/index.ts`, both the `fleet_relaunch` tool and the `/fleet relaunch` command now clear `active.killSwitch.killed = false` and `active.pauseSwitch.paused = false` after `resetForRelaunch(...)` and before `startLoop(...)`. This prevents a stale kill request from immediately killing the freshly reset nodes.

**Test evidence:**
- `test/scheduler-relaunch.test.ts`:
  - `relaunch with a stale killed switch kills reset nodes` — confirms the scheduler still honors a live kill switch, so the only safe relaunch behavior is to clear it.
  - `relaunch succeeds when killed switch is cleared` — confirms that once the switch is cleared, `runFleet` dispatches the reset nodes and completes.

## Finding 2 — relaunch of paused loop fleet re-pauses

**Change:** Same site as Finding 1 (`src/index.ts` `fleet_relaunch` tool and `/fleet relaunch` command). `active.pauseSwitch.paused` is reset to `false` before `startLoop(...)`. The scheduler already clears `state.paused` when `resumeFrom` is supplied, but the shared `pauseSwitch` object persists across calls and was causing an immediate boundary pause.

**Test evidence:**
- `test/scheduler-loop.test.ts`: `resumeFrom clears paused state and proceeds when pauseSwitch is false` — a paused boundary state with `pauseSwitch: { paused: false }` resumes and completes instead of pausing again.

## Finding 3 — fleetCost double-counts snapshot costs

**Change:** `snapshotIteration` in `src/state.ts` now archives a structured clone of the current nodes *and* zeros `cost_usd_estimate` on the live nodes before returning state. This makes `fleetCost = sum(live nodes) + sum(snapshot nodes)` disjoint by construction: replay-node costs are already zeroed by `resetForIteration`, and run-once / terminal-node costs are moved into the snapshot and zeroed live. Subsequent `patchNode`, `resetForIteration`, and `resetForRelaunch` calls recompute a correct total.

**Test evidence:**
- `test/state-loop.test.ts`: `snapshotIteration archives costs and zeros live node costs` — asserts snapshot retains costs while live nodes become `0`.
- `test/scheduler-cost.test.ts`: `loop with run-once node counts its cost exactly once` — two-iteration loop with a run-once node costing `0.1` and a replay node costing `0.05` per iteration produces total `0.2` (not the pre-fix `0.45`).
- `test/state-cost.test.ts`: `resetForRelaunch preserves fleet cost when live costs are already archived` — resetting a failed node after `snapshotIteration` does not change the fleet total.

**Test updates:**
- No existing tests were changed. New tests only.

## Verification

```bash
npx vitest run   # 111 passed (23 files)
npx tsc --noEmit # clean
```
