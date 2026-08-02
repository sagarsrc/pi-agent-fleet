# Fleet Hardening — Module Split + Bug Batch A (Design)

Date: 2026-08-02
Source: `todo.md` items #1, #2, #3, #9, #12, #13, #14. Items #4–#8, #10, #11 (config/control) and #5, #6 (browser canvas, dynamic nodes) are deferred to later plans.

## Goal

Split the 600-line `src/index.ts` into focused modules, then fix five bug/UX classes: effort control, launch-confirm flow, widget quality (truncation/spinner/stats), model bias, and model-unavailability resilience.

## Architecture

### Module split (todo #9)

`src/index.ts` shrinks to extension wiring only. New/existing modules:

| Module | Responsibility |
|---|---|
| `src/index.ts` | Extension entry: registers tools + `/fleet` command, session_start hook |
| `src/model-resolution.ts` | `aliasesFor`, `resolveModelReference`, `validateFleetModels` |
| `src/fleet-store.ts` | `fleetRootFor`, `isInsideGitRepo`, `ensureFleetGitignore`, `writePlanFiles`, `writeWorkerPrompts` |
| `src/controller.ts` | `ActiveFleet`, `updateWidget`, `startLoop`, `killFleet`, spinner ticker, status/dag helpers |
| `src/tools.ts` | All `pi.registerTool` registrations + Typebox schemas |
| `src/command.ts` | `/fleet` slash command handler |
| `src/runner.ts` | gains `sessionFactoryForModel` (moved from index.ts) + `thinkingLevel` plumbing |

Pure move for existing behavior; new tests for the extracted pure units.

### Effort / thinking level (todo #1)

- `FleetConfig.effort?: ThinkingLevelName`, `WorkerSpec.effort?: ThinkingLevelName`.
- `ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- `validateFleetSpec` defaults `config.effort` to `"medium"` and rejects unknown values.
- Effective effort per worker: `worker.effort ?? config.effort` → passed via `runWorker({ thinkingLevel })` → `createAgentSession({ thinkingLevel })`.
- Tool schemas expose `effort` on config + worker.

### Model defaults, de-bias, confirm flow (todo #13, #2)

- `FleetConfig.model` becomes optional. No `"gpt-5.4"` default anywhere.
- Resolution order at spawn: `worker.model` → `config.model` → pi session default model.
- Widget/DAG label fallback: `(default)`.
- `fleet_plan` description: neutral, tier-based model guidance with no brand names; result text ends with explicit instruction to show the preview and wait for user confirmation before `fleet_launch`.
- `fleet_launch` description tightened: call only after user confirmation; `skip_confirm` only when the user already approved.

### Model resilience (todo #14)

- `validateFleetModels(spec, registry)`: resolves `config.model` + every `worker.model`; returns list of unresolvable refs (with ambiguous/not-found detail).
- `fleet_plan`: hard-fails with the model errors — no fleet root created.
- `fleet_launch`: re-validates; hard error, nothing launches.
- `runWorker`: session factory call wrapped in try/catch → returns `{ ok: false, error }` instead of throwing, so one node's session-creation failure stays a per-node failure.

### Widget overhaul (todo #3, #12)

`buildWidgetLines(spec, state, opts?: { maxLines?: number; spinnerFrame?: number })`:

- Completed/failed nodes keep stats: `✓ id (model) · N turns · Xk tok · $Y`.
- Running nodes show animated spinner: frame char from `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` selected by `spinnerFrame`.
- Header: `streak` → `lgtm streak`.
- Truncation: default `maxLines = 12`. Node lines beyond budget are collapsed into `… +N more (x/y done)`; running/failed nodes always stay visible.
- `controller.ts` runs a 150 ms interval ticker while the fleet is running that re-renders the widget with an incremented frame; cleared on loop end.

## Data flow

Unchanged: tool → controller → scheduler → runner, with state.json persistence. Widget updates flow through `updateWidget(ctx, fleet)` only.

## Error handling

- Model resolution failures: surfaced at plan/launch time (fail fast) and contained per-node at run time.
- Session factory throw: contained per-node as `{ ok: false }`.
- Refactor task must keep all 111 existing tests green without weakening assertions (test updates allowed only where behavior intentionally changes: model default removal, widget lines, header label).

## Testing

- vitest, TDD per task: failing test first, then minimal implementation.
- New tests: `test/model-resolution.test.ts`, `test/fleet-store.test.ts`, additions to `dag`, `runner`, `ui` test files.
- `npm test` + `npm run typecheck` green after every task.

## Out of scope (later plans)

- `/fleet configure`, `/fleet edit`, single-node kill, planning gate (todo #4, #7, #8, #10)
- Browser live-status canvas, dynamic node insertion (todo #5, #6, #11)
