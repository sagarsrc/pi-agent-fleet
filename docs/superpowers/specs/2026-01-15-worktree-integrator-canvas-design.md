# Worktree Integrator + Canvas Redesign Design

Date: 2026-01-15

## Goals

1. Make fleets with multiple git worktrees safe by automatically creating worktrees, merging their branches in dependency order, and surfacing merge conflicts before the integrator agent runs.
2. Redesign the browser canvas so it looks modern, reads like a workflow IDE (LangGraph/React Flow style), and lets users expand nodes to inspect details without leaving the canvas.

## Worktree integrator

### Current state

- `worktree: true` on a worker passes a custom `repoCwd` to the agent session (`<fleetRoot>/worktrees/<nodeId>`), but the worktree directory is never created by the extension.
- Multiple worktree workers can silently edit the same repo files with no merge stage, so the "last writer wins" or files are left in separate branches.

### New behavior

1. **Plan-time validation**
   - If ≥2 workers have `worktree: true`, the fleet MUST end with an integrator. The planner/validator auto-injects a `code-run` integrator worker if the user did not supply one.
   - The integrator depends on every worktree worker.
   - Repo-relative output paths on worktree workers are treated as **ownership claims**. Two worktree workers claiming the same path is allowed only when there is an ordered handoff dependency (`A depends_on B` or `B depends_on A`). Otherwise the plan is rejected with a conflict list.

2. **Runtime worktree creation**
   - Before each worktree worker runs, the scheduler creates a git worktree from the base repo at `<fleetRoot>/worktrees/<nodeId>` on a deterministic branch `fleet/<fleet-name>/<nodeId>`.
   - The agent session runs in that worktree.

3. **Auto-commit after worktree completion**
   - When a worktree worker reaches `completed`, the scheduler stages and commits all changes in that worktree with a deterministic message: `fleet: <fleet-name> <nodeId> iteration <n>`.
   - If the commit fails (e.g., nothing to commit), the run is marked `failed` with the git error.

4. **Integrator merge stage**
   - Before the integrator worker is spawned, the scheduler creates an integrator worktree at `<fleetRoot>/worktrees/fleet-integrator` from base `HEAD`.
   - It merges each worktree branch in dependency order using `git merge --no-ff --no-edit`. Clean merges proceed automatically.
   - If a merge conflict occurs, the integrator is marked `failed` with a `status_note` listing the conflicting files. The integrator agent is **not** spawned in this case; the operator must resolve the conflict and relaunch.
   - If all merges are clean, the integrator agent runs in the prepared worktree. Its prompt includes the list of merged branches and any instructions to verify/resolve edge cases.

5. **Failure modes**
   - `worktree workers require a git repo` — already checked at launch.
   - `worktree creation failed` — worker fails before spawn.
   - `merge conflict: <files>` — integrator fails, operator resolves manually and relaunches.
   - `no integrator` — plan rejected when ≥2 worktrees and no integrator path exists.

## Canvas redesign

### Visual direction

Modern workflow IDE, not a dashboard. Dark-first with a clean light variant. LangGraph/React Flow influences:

- Infinite canvas with pan/zoom/fit (already present).
- Floating controls: zoom, fit, 1:1, theme, minimap toggle.
- MiniMap in bottom-right showing viewport rectangle.
- Card nodes with rounded corners, subtle borders, status-color top accent instead of side stripe.
- Expandable nodes: collapsed state shows id, type, status, model, cost; expanded state adds task excerpt, outputs, status note, last session entry preview.
- Edges: smooth cubic bezier, arrowheads, optional dependency labels.
- Animated running spinner on the node card.
- Light/dark themes via `data-theme` and CSS variables, persisted in URL/localStorage.
- Better layout: layer nodes with rank-based x and distribute y to reduce crossings.
- Empty state, loading state, fleet picker.

### Static test mode

A new `/api/demo` endpoint returns a synthetic fleet payload so the UI can be iterated without a live fleet. `?demo=1` on the canvas page loads the demo payload.

### API changes

- `CanvasPayload` keeps the same schema so existing tests still pass; only the rendered HTML changes.
- Add optional `demo` query to the canvas page; the JS fetches `/api/state` by default or `/api/demo` when `?demo=1`.

## Implementation notes

- Worktree logic belongs in `src/scheduler.ts` and `src/dag.ts` (validation).
- Canvas logic lives entirely in `src/canvas.ts` (HTML/CSS/JS string) plus tests.
- New tests for worktree creation, ownership conflicts, auto-commit, and integrator merge failures.
- New tests for canvas demo endpoint and static payload rendering.

## Success criteria

- `npm test` passes with new tests.
- `npm run typecheck` passes.
- A fleet with two `worktree: true` workers auto-injects an integrator, creates worktrees, merges clean branches, and completes.
- A fleet with two `worktree: true` workers editing the same file without an ordered handoff is rejected at plan time.
- Canvas `/api/demo` renders a modern graph with expandable nodes in both themes.
