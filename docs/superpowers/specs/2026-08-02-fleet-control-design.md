# Fleet Control — Configure, Node Kill, Edit, Design (Design)

Date: 2026-08-02
Source: `todo.md` items #4 (`/fleet configure`), #7 (planning gate / extension plans the fleet), #8 (single-node kill), #10 (`/fleet edit` mid-run config). Items #5, #6, #11 (browser canvas, dynamic nodes) remain for the next plan.

## Goal

Give the user control over fleet defaults and live fleets: persistent preferences, single-node kill, mid-run editing of pending nodes and fleet config, and a `fleet_design` tool that drafts a fleet DAG from plain requirements.

## Architecture

### Preferences (todo #4)

New module `src/preferences.ts`.

- Global preferences file: `~/.pi/agent/fleet.json` (path injectable for tests).
- Shape: `FleetPreferences = { max_concurrent?: number; model?: string; effort?: ThinkingLevelName; warn_cost_usd?: number }` — all optional.
- API: `loadPreferences(path?): Promise<FleetPreferences>` (missing/corrupt → `{}`), `savePreferences(prefs, path?)`, `mergeFleetConfig(raw: unknown, prefs: FleetPreferences): unknown` (fills only absent `config.*` fields of a raw fleet definition from prefs).
- `fleet_plan` merges prefs into the raw definition before validation; prefs-provided `model` then flows through the existing `validateFleetModels` check.
- `/fleet configure` (works with or without an active fleet):
  - `/fleet configure` — interactive wizard: select field (or done) → input value (validated per field; empty clears) → save.
  - `/fleet configure show` — print current preferences.
  - `/fleet configure set <key> <value>` — direct set, same validation.
- Validation: `max_concurrent` integer ≥ 1; `warn_cost_usd` number ≥ 0; `effort` one of the `ThinkingLevelName` values; `model` non-empty string (resolution checked at plan time, not here — prefs must work offline of a registry).

### Single-node kill (todo #8)

- `ActiveFleet` gains `sessions: Map<string, AgentSessionLike>` and `killedNodes: Set<string>`.
- `RunWorkerOpts` gains `onSession?: (session: AgentSessionLike) => void`, invoked right after factory success; controller registers the session per node and deletes it when `runWorker` returns.
- `RunFleetOpts` gains `nodeKills?: ReadonlySet<string>`:
  - dispatch pass: a `pending`/`ready` node in `nodeKills` is patched `killed` instead of dispatched.
  - spawn-result handler: `!res.ok` → status `killed` when the id is in `nodeKills`, else `failed`.
- `killFleet(target)`: `"all"` unchanged. Node id: unknown → error; already terminal → message; otherwise add to `killedNodes`, abort live session if present, patch state directly when the fleet is not running.
- `fleet_kill` tool + `/fleet kill` accept a node id; descriptions updated.

### Mid-run edit (todo #10)

New module `src/edits.ts`.

- `editNode(fleet, nodeId, key, value, registry)`: node status must be `pending` or `ready`. Keys: `model` (resolved via registry, stored canonical `provider/id`), `effort` (validated), `task` (non-empty; regenerates `prompt.md` when it already exists). Persists `fleet.json`.
- `editConfig(fleet, key, value, registry)`: keys `max_concurrent`, `warn_cost_usd`, `model`, `effort` — same validation; persists `fleet.json`. Live effect: the scheduler re-reads `spec.config.max_concurrent` every dispatch pass, `checkCostWarning` re-reads `warn_cost_usd` per event, and spawn re-reads `config.model` per node.
- `/fleet edit <node_id> model|effort <value>`, `/fleet edit <node_id> task [text…]` (opens `ctx.ui.editor` when no text given), `/fleet edit config <key> <value>`.
- New tool `fleet_edit` mirroring the command: `{ node_id?: string; key: string; value: string }` — no `node_id` → config edit.

### Fleet design (todo #7)

New module `src/planner.ts` + new tool `fleet_design`.

- `fleet_design` params: `{ requirements: string, fleet_name?: string }`.
- Builds a planner prompt (schema reference + rules + the user's requirements), runs it as a `write`-type worker via the existing `runWorker` (session default model, medium effort), into `.fleet/design-<name>-<ts>/planner/`.
- Planner writes `output/fleet.json` (definition WITHOUT model refs — validation and prefs fill those) and `output/rationale.md`.
- Extension parses `fleet.json`, runs `validateFleetSpec`; valid → returns the ASCII preview + the JSON + "show the user; call fleet_plan with this definition after they confirm"; invalid → returns validation errors + the draft JSON so the caller can repair and retry.
- `buildPlannerPrompt` is pure and tested; `runFleetDesign` takes an injectable `sessionFactory` and is tested with a fake.

## Data flow

- Preferences: `/fleet configure` → `~/.pi/agent/fleet.json` → `fleet_plan` merge → validated spec.
- Kill: command/tool → `killedNodes` + session abort → scheduler patches `killed` → dependents `blocked` → `fleet_relaunch` can revive (existing).
- Edit: command/tool → `edits.ts` → `fleet.json` + in-memory spec → live scheduler reads on next pass.
- Design: requirements → planner worker → `fleet.json` draft → validation → preview → existing `fleet_plan` flow.

## Error handling

- Corrupt preferences file → treated as empty, never crashes planning.
- Kill of unknown/terminal node → explicit message, no state change.
- Edit of non-pending node → explicit refusal listing current status.
- Planner session failure or missing/invalid draft → tool error result with details; no fleet root created.

## Testing

- vitest TDD per task. New: `test/preferences.test.ts`, `test/edits.test.ts`, `test/planner.test.ts`; additions to `test/scheduler.test.ts` (nodeKills), `test/runner.test.ts` (onSession), `test/controller.test.ts` (killFleet node targets).
- `npm test` + `npm run typecheck` green after every task.

## Out of scope (next plan)

- Browser live-status canvas (#5), dynamic node insertion (#6, #11).
