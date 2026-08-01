# Finding: loop fleets live smoke results

**Date:** 2026-08-01
**Experiment:** 001-fleet-extension-impl
**Verdict:** PASS (second attempt)

## Setup

Headless `pi -ne -e ./src/index.ts --model openai-codex/gpt-5.4 -p`, fleet `loop-smoke2`: writer-a (`# 123`), writer-b (`# 456`), reviewer verdict gate. All workers `gpt-5.4-mini`. Loop: `gate: reviewer, max_iterations: 3, lgtm_count: 1`. Trivial tasks by design.

## Result

- Final fleet status: **completed** in **2 iterations** (streak 1/1)
- Verdict history: iteration 1 `iterate` ("writer-a: add word done to a.md") → iteration 2 `lgtm`
- Feedback loop closed for real: `a.md` gained `done` in iteration 2
- `state.json`: 2 snapshots with verdict + verdict_body; archive `iterations/{1,2}/workers/*` has outputs + per-iteration prompts
- Report `## Iterations` table present (n | verdict | tokens | cost | duration); cost $0.00 (known v1 token-only limitation)
- Iteration-2 prompts archived with `## Reviewer feedback (iteration 1)` (writer-a) and `## Previous reviews` (reviewer) — injection confirmed on disk, not just in tests

## Attempt 1 failure (real product gap)

First smoke failed: reviewer wrote `iterate` without the required `verdict: ` prefix → `contract_failed` → fleet failed. Root cause: generated worker prompts never teach the verdict line format; the old bash iterative-fleet skill mandated explicit verdict-writing instructions in every reviewer prompt. **Fix queued for final review wave: prompts.ts gains a verdict-format section for verdict-output nodes.**

## Numbers

- 79/79 unit tests + tsc clean at smoke time
- Iteration durations: 30.5s / 36.1s (gpt-5.4-mini, trivial tasks)
- Tokens per iteration: ~50k / ~46k

## Watch-outs

- Reviewer task text must state the `verdict: ` line format explicitly until the prompts.ts fix lands
- Cost cap is inert (token-only estimate) — `max_iterations` is the real safety cap
