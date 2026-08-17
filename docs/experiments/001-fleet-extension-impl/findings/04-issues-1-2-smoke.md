# Finding: gh issues #1+#2 fixes — live smoke results

**Date:** 2026-08-18
**Experiment:** 001-fleet-extension-impl
**Branch:** fix/gh-issues-1-2
**Verdict:** PASS (first attempt)

## Setup

Headless `pi -ne -ns -e ./src/index.ts --model openai-codex/gpt-5.4 -p` from the fix worktree, fleet `issue1-smoke-20260817184320`. All workers `openai-codex/gpt-5.4-mini`. Dead-simple write tasks by design (token budget).

DAG: `slow` (write `# 789` + numbers 1..2000) ∥ `failer` (told to write nothing, required output → contract_failed by design) → `downstream` (depends on failer, placeholder task).

## Driver actions + results

1. `fleet_plan` + `fleet_launch(skip_confirm)` — launched.
2. Polled until `failer` = contract_failed, `downstream` = blocked, `slow` still running.
3. **While fleet running:** `fleet_edit downstream task` (blocked node — issue #1 bug 3) → accepted. `fleet_edit failer task` → accepted. `fleet_relaunch failer` (issue #1 bug 2) → returned exactly:
   > `relaunch queued for failer (fleet running; dispatches on next scheduler pass)`
   
   Pre-fix behavior: `"fleet is running"` + silent no-op. Fixed.
4. Final fleet status: **completed**. `slow: completed`, `failer: completed`, `downstream: completed` (ran with edited task — bug 3 fix verified end-to-end).

## Bug 1 (autonomy preamble) verification

All 3 worker `prompt.md` files start with `## Autonomy contract (read first)` and contain `PRE-APPROVED` (3/3 via grep). Workers acted without approval questions.

## Numbers

- Worker tokens: slow 21.8k ($0.0296), failer 11.4k ($0.0061), downstream 11.5k ($0.0057). Total ≈ 44.7k tokens, ≈ $0.041. Within budget.
- 308/308 unit tests green + tsc clean at smoke time.
- `cost_usd_estimate` non-zero for gpt-5.4-mini (pricing known) — bug 5 note not triggered, as expected.

## Canvas (issue #2)

Unit-level only this run: TD layout math (issue-#2 DAG shape: parents strictly above children), `user-select:text` + `note nodrag` in rendered bundle, collapsed/relocated instructions panel, excerpted dense cards — all asserted in `test/canvas-layout.test.ts` / `test/canvas.test.ts`. Visual check left to user via `/fleet canvas`.
