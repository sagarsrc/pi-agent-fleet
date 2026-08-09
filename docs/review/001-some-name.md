# Issue: Fleet reviewer contracts repeatedly failed despite usable artifacts

## Summary

Multi-agent research fleet repeatedly stalled at reviewer nodes because contract validation expected required markdown files with a markdown heading, while reviewer prompts instructed agents to start outputs with `Status: ...` or failed to write the expected file path. Operators had to manually patch state and artifacts to move DAG forward.

## Impact

- Fleet required repeated manual intervention.
- Completed upstream work was at risk of being rerun accidentally.
- `fleet_launch` on existing active fleet restarted earlier nodes instead of resuming from failed point.
- Reviewer gates became operational blockers rather than quality gates.
- Final output was produced only after manual state hacks.

## Timeline / Symptoms

- `review-gap-map` failed: `no markdown heading`.
- `review-hypotheses` failed: `no markdown heading`.
- `review-mve-designs` failed: same contract shape problem.
- `review-costs` failed: `missing required output: output/review-costs.md`.
- `final-reviewer` failed: `missing required output: output/final-review.md`.
- Some reviewer output files existed under worker dirs but did not satisfy validator shape.
- Relaunch sometimes reused stale `workers/<id>/prompt.md`, so edits to `fleet.json` did not affect already-materialized prompts.

## Root causes

### 1. Prompt/contract mismatch

Reviewer tasks said:

```text
Start with Status: approved|needs-revision|escalate
```

But output contract was:

```json
{ "path": "output/review-*.md", "kind": "markdown", "required": true }
```

Markdown validator expected first meaningful line to be a markdown heading (`# ...`). `Status:` first caused `no markdown heading` even when review content was good.

### 2. Stale worker prompts after fleet edits

`fleet_edit` or direct `fleet.json` edits did not update already-created `workers/<id>/prompt.md`. Relaunch reused stale prompt files, so failed reviewer kept producing same invalid output.

### 3. Resume semantics unclear / dangerous

Using `fleet_launch` after manual state patch restarted whole DAG. Expected behavior was resume pending/failed work only. This caused accidental rerun of already-completed layer 0 research nodes.

### 4. Contract failure loses useful artifact state

Several failed reviewers had produced useful content, but `produced_outputs` stayed empty because validator failed. Fleet state treated node as unusable rather than preserving artifact + validation error separately.

### 5. Reviewer gates too fragile for non-code research flow

Reviewers were quality gates, but their output contract was stricter than needed. Missing heading or missing path blocked entire DAG even when downstream could safely continue with warning.

## Manual workaround used

For each failed reviewer:

1. Normalize/create expected output file:
   - `# Review: ...`
   - blank line
   - `Status: approved|needs-revision|escalate`
2. Patch `state.json` node:
   - `status: completed`
   - `produced_outputs: ["output/<file>.md"]`
   - `contract_result.ok: true`
3. Mark next node as relaunchable.
4. Use `fleet_relaunch <next-node>` instead of `fleet_launch`.

## What should improve

### Product fixes

- Contract validator should accept markdown files that start with known metadata lines like `Status:` if a heading appears soon after.
- Or reviewer contract template should always require heading first:

```markdown
# Review: <thing>

Status: approved
```

- `fleet_edit` should update pending/blocked/failed worker prompt materialization or warn: “existing prompt.md unchanged”.
- `fleet_relaunch` should regenerate prompt from current `fleet.json` unless explicitly disabled.
- `fleet_launch` should refuse to run on partially completed failed fleet unless user confirms “restart whole DAG”.
- Add `fleet_resume` / `fleet_continue` for “dispatch ready pending nodes from current state”.
- Preserve produced artifacts even when contract validation fails.
- Show exact artifact path actually written vs expected path.

### Plan/design fixes

- Avoid reviewer gates unless needed; use synthesizer self-audit sections for early flow.
- Make output contracts machine-checkable but forgiving:
  - required file exists
  - non-empty
  - contains `Status:` anywhere in first 10 lines
  - contains one heading anywhere in first 10 lines
- For research fleets, prefer final audit + structured artifacts over many hard reviewer blockers.

## Acceptance criteria for fix

- Failed reviewer that writes `Status:` then heading should pass or receive clear prompt/schema error before execution.
- Editing a failed node task and relaunching must use updated prompt.
- Relaunching one node must not restart completed ancestors.
- UI should expose: expected output path, actual output path, validation error, first 5 lines of output.
- There should be a safe “continue from current state” command.

## Related fleet

Fleet root:

```text
/Users/sagar/work/multi-agent-research/.fleet/multi-agent-research-fleet-20260809122328
```

Key artifacts:

```text
workers/final-backlog-synthesizer/output/final-backlog.md
workers/final-reviewer/output/final-review.md
state.json
report.md
```
