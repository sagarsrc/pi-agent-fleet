# Finding: edge-case hardening wave

**Date:** 2026-08-01 · **Verdict:** shipped

## What

Post-ship edge-case audit of loop fleets → 10 fixes + 1 follow-up, commits `9f2b732..faf5109` (4 commits), 93/93 tests, tsc clean, k3 review all-ADDRESSED.

## Fixed

1. Verdict prompt examples flush-left (indent broke `^`-anchored regex when reviewer copied it)
2. `VERDICT_RE` case-insensitive (`Verdict: LGTM` now parses; value normalized lowercase)
3. Replay-node `output/` cleaned at every iteration reset — both in-loop AND resume paths (shared `cleanReplayOutputs` helper) — kills stale-file false contract passes
4. Validation: `lgtm_count > max_iterations` rejected
5. Validation: `gate: none` + all run-once nodes rejected (no-op loop)
6. `snapshotIteration` started_at = earliest across replay nodes only (run-once no longer inflates durations)
7. Widget streak shown only for reviewer gate
8. `fleet_pause` rejects one-shot fleets
9. `isInsideGitRepo` EACCES → keeps ascending
10. Escalate notify includes report path

## Deliberately not fixed (bloat rulings)

- Fleet cost accumulation across iterations — inert while cost estimate is $0.00 token-only; revisit with per-model pricing
- Pause-intent loss on mid-iteration crash — dead-session recovery is v2.1 scope
- `worktree: true` on output-only node (harmless noise) — allowed

## Residual accepted risks

- `isInsideGitRepo` catch-all can mask genuine I/O errors (probe-only, benign)
- Gate-none widget always shows `last verdict: —` (cosmetic)
