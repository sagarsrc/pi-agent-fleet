# Fleet Dynamic Nodes (Design)

Date: 2026-08-03
Source: `todo.md` items #6 (add graph nodes on the fly; synthesis node decides it needs another node), #11 (make fleets more dynamic). Item #5 (browser canvas) is the next plan.

## Goal

Let a running or planned fleet grow: workers can request additional nodes via a sideband file, and users/agents can insert nodes explicitly with a `fleet_add_node` tool / `/fleet add` command.

## Architecture

### Scheduler auto-initialization (`src/scheduler.ts`)

The scheduler currently assumes `state.nodes` covers every `spec.workers` entry. New behavior: at the top of every dispatch pass, any spec worker missing from `state.nodes` is initialized as `pending` (state persisted), then `opts.onNodeAdded?.(worker)` is awaited (lets the controller prepare worker dirs/prompts before dispatch). Insertion into `spec.workers` is done by the controller; the scheduler only observes and initializes. Loop machinery (`resetForIteration`, `cleanReplayOutputs`, `snapshotIteration`) already iterates `spec.workers`, so inserted nodes participate in subsequent iterations naturally.

### Insertion module (`src/insert.ts`)

`insertWorkers(fleet, raw, registry) → { ok, message, inserted? }`:

1. Accepts a bare array or `{ "workers": [...] }`.
2. Builds a candidate fleet (existing workers + requested) and runs the full `validateFleetSpec` — this enforces unique kebab-case ids, known deps, acyclicity, and loop-gate rules (e.g. still exactly one verdict sink) on the merged graph.
3. Resolves any `model` refs on the new workers (canonical `provider/id` stored).
4. Appends to `fleet.spec.workers`, persists `fleet.json` (atomic tmp+rename), creates `workers/<id>/output` dirs, writes each new node's `prompt.md` via `buildWorkerPrompt`.
5. When the fleet is NOT running, also initializes `state.nodes[id]` as pending and persists `state.json` (when running, the scheduler's auto-init owns state).

### Node-request sideband (worker-driven insertion)

- Any worker may write `<workerDir>/output/node-requests.json` — `{ "workers": [ WorkerSpec, ... ] }`.
- `src/prompts.ts` gains a "Requesting additional nodes" section documenting the contract (schema, unique ids, depend on your own id to consume your outputs).
- Controller: after a node reaches `completed`, `collectNodeRequests(fleet, nodeId, registry)` reads the sideband (absent → no-op; invalid JSON / validation failure → `status_note` on the requesting node) and calls `insertWorkers`.

### Explicit insertion (user/agent-driven)

- New tool `fleet_add_node`: `{ workers: WorkerSchema[] }` (reuses the existing worker schema) → `insertWorkers`. Works on planned, running, paused, and finished-with-pending fleets.
- `/fleet add <json>` — JSON body is a worker object, an array, or `{ "workers": [...] }`.

## Data flow

- Worker-driven: worker writes sideband → contract patch `completed` → `collectNodeRequests` → `insertWorkers` → spec/fleet.json/dirs/prompt → scheduler auto-init next pass → dispatch.
- Explicit: tool/command → `insertWorkers` → same path. If mid-run, node joins the current pass; deps already satisfied (completed) dispatch immediately.

## Error handling

- Validation rejects the whole batch atomically — no partial insertions.
- Sideband JSON parse/validation errors surface as `status_note` on the requesting node (never crash the run).
- Insertions into a completed fleet: refused with a clear message (use `fleet_relaunch` semantics instead).

## Testing

- Scheduler: spec growth mid-run is auto-initialized and dispatched; `onNodeAdded` fired.
- insert.ts: happy path (state/dirs/prompt/fleet.json), duplicate id, unknown dep, cycle, bad model, verdict-sink violation under reviewer loop.
- Controller: `collectNodeRequests` sideband → inserted; bad JSON → status_note.
- prompts.ts: documents the sideband contract.

## Out of scope (next plan)

- Browser live-status canvas (#5).
