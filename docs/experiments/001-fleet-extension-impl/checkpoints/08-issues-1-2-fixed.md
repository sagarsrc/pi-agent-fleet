# Checkpoint: gh issues #1 + #2 fixed

**Date:** 2026-08-18
**Branch:** fix/gh-issues-1-2
**Plan:** docs/experiments/001-fleet-extension-impl/plans/02-gh-issues-1-2-fleet-core-canvas.md
**Smoke:** docs/experiments/001-fleet-extension-impl/findings/04-issues-1-2-smoke.md

## Shipped (issue #1 — fleet core)

1. **Autonomy preamble** (`src/prompts.ts`): every worker prompt starts with an autonomy contract — PRE-APPROVED, no human present, never end turn with a question, skip approval-gated skills. Kills the brainstorming hard-gate death (~510k tokens burned in the reported run).
2. **Relaunch while running** (`src/scheduler.ts`, `src/controller.ts`, `src/state.ts`, `src/tools.ts`, `src/command.ts`): `relaunchRequests: Set<string>` shared with the scheduler, drained at the top of every pass AND at wind-down (`runPassUntilDrained`). Single `requestRelaunch` entry point for tool + command. `relaunchResetIds` extracted from `resetForRelaunch`.
3. **Blocked nodes editable + killable** (`src/edits.ts`, `src/controller.ts`, `src/scheduler.ts`): `blocked` added to editable statuses; killFleet special-cases blocked; scheduler honors nodeKills for pending/ready/blocked each pass.
4. **file-exists freshness** (`src/contracts.ts`, `src/scheduler.ts`): repo-relative file-exists outputs must have mtime >= worker dispatch time (`notBeforeMs`), else fail "pre-existing repo file not modified since worker start".
5. **Zero-cost surfacing** (`src/scheduler.ts`): nodes with tokens > 0 but cost 0 get `status_note: "cost unavailable: no pricing for model (N tokens used)"`.
6. Bonus (pre-existing WIP + review fix): `readDiskFleet` tolerates bare fleet.json-only roots, but only on ENOENT — corrupt state.json still throws.

## Shipped (issue #2 — canvas)

1. **Copyable errors**: `nodrag` + `user-select:text; cursor:text` on `.note`/`.fail-reason`; session text selectable. esbuild `minify: false` keeps hooks inspectable.
2. **Top-down DAG layout**: layout extracted to `src/canvas-layout.ts` (pure, unit-tested); deterministic layered TD positions, narrow layers centered; handles flipped Top/Bottom.
3. **Instructions tucked**: collapsed by default, moved below the session timeline, retitled "Instructions (task prompt)".
4. **Dense cards**: assistant/user prose excerpted at 240 chars (`excerptText`) with show more/less; tighter timeline CSS.

## Process

SDD + TDD: 8 tasks, fresh implementer per task, task review per task, 3 fix rounds total (recovery ENOENT narrow, relaunch wind-down drain, canvas test tightening) + 1 deflake round (test-only deadlock found by controller stress: 3/7 suite runs → 8/8 clean after fix). Live smoke: headless pi, dead-simple mini-model fleet, ≈44.7k worker tokens.

## Test count

281 (baseline) → 308, all green; `npx tsc --noEmit` clean.

## Parked minors (from reviews)

- `recoverLatestFleet`/`listFleetRoots` still broad-catch corrupt state (pre-existing).
- Per-dispatch nodeKills check now dead code (superseded by pre-dispatch kill block).
- `edits.ts` refusal message omits "ready" (plan-mandated string).
- No test locks undefined-cost no-note behavior (prod-unreachable).
- Canvas runtime click UX verified only via unit/HTML assertions; visual pass left to user.
