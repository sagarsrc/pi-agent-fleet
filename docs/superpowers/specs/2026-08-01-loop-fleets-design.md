# Loop Fleets — iterative, autoresearch, and worktree modes for the fleet extension

**Date:** 2026-08-01
**Status:** Draft, awaiting user review
**Repo:** `pi-fleet-extension` (extends v0.1.0)
**Supersedes scope of:** checkpoint 03 "iterative fleet" (expanded during brainstorming to unified loop scaffolding)

## 1. Overview

v0.1.0 runs a static DAG once. v2 adds a **loop**: after the DAG reaches all-terminal, a **gate** decides whether to replay it. Three modes fall out of one abstraction:

- **iterative fleet** — `gate: "reviewer"`: a reviewer node's verdict (`lgtm | iterate | escalate`) gates replay until a quality bar passes
- **autoresearch fleet** — `gate: "none"`: loop until caps; eval instructions live in worker task text (Karpathy pattern; eval harness is the quality gate, not a reviewer)
- **worktree mode** — per-node opt-in flag: worker creates its own git worktree at a designated path; conflicts resolved by downstream resolver nodes. Composes with both gates and with one-shot fleets

Explicitly deferred (v2.1+): plateau-triggered search injection, extension-run eval machinery, metric parsing, per-node cost budgets, single-node kill/relaunch, JIT node-add, dead-session recovery, per-model pricing (cost estimate stays token-only).

## 2. Philosophy invariants (preserved from v1)

- No auto-restart, no auto-kill, no babysitting. Operator owns kills
- Contract checks at worker exit only; extension never intervenes mid-run
- Gate decisions at **iteration boundary** only — never mid-iteration
- Extension runs **zero git commands** — workers own their worktrees and commits
- Single-writer `state.json`; no sentinel files (pause is a state field)
- Deterministic counting in code (streaks, iterations), never in the LLM

## 3. Schema

### 3.1 fleet.json additions

```jsonc
{
  "fleet_name": "...", "type": "dag",
  "config": {
    "max_concurrent": 4,
    "model": "gpt-5.4",
    "warn_cost_usd": 5.0,
    "loop": {
      "gate": "reviewer",        // "reviewer" | "none" — required when loop present
      "max_iterations": 5,       // integer >= 1, required
      "lgtm_count": 1            // integer >= 1, reviewer gate only; default 1
    }
  },
  "workers": [{
    "id": "build-x", "type": "code-run", "task": "...",
    "iterate": true,             // default true; false = run-once node
    "worktree": true,            // default false; worktree directive injection
    "depends_on": [], "outputs": []
  }]
}
```

`config.loop` absent → v1 one-shot behavior, byte-identical semantics.

### 3.2 TypeScript types (extensions)

```ts
export type GateKind = "reviewer" | "none";

export interface LoopConfig {
  gate: GateKind;
  max_iterations: number;
  lgtm_count: number;          // defaulted to 1 at validation
}

export interface WorkerSpec {
  // ... v1 fields ...
  iterate: boolean;            // defaulted true at validation
  worktree: boolean;           // defaulted false at validation
}

export type Verdict = "lgtm" | "iterate" | "escalate";

export interface ContractResult {
  ok: boolean;
  checks: ContractCheck[];
  verdict?: Verdict;        // parsed from verdict-kind output when present
  verdict_body?: string;    // body below the verdict line
}

export interface IterationSnapshot {
  n: number;                   // 1-based
  verdict: Verdict | null;     // null when gate: "none"
  verdict_body: string | null; // review body below verdict line
  started_at: string;
  ended_at: string;
  nodes: Record<string, NodeState>;
}

export type FleetStatus = "planned" | "running" | "paused" | "completed" | "failed" | "killed";

export interface FleetState {
  // ... v1 fields ...
  iteration: number;           // current, 1-based
  lgtm_streak: number;
  paused: boolean;
  iterations: IterationSnapshot[];
  cost_usd_estimate: number;   // cumulative across iterations
}
```

Fleet status lifecycle: `planned → running ⇄ paused → completed | failed | killed`. `paused` is the only non-terminal addition.

## 4. Validation rules (dag.ts additions)

1. `loop.max_iterations`: integer ≥ 1 (required when `loop` present)
2. `loop.gate`: required when `loop` present (no implicit default)
3. `loop.lgtm_count`: integer ≥ 1; rejected when `gate: "none"`
4. `gate: "reviewer"` requires **exactly one** node with a `verdict`-kind output; that node must (a) have `iterate ≠ false`, (b) be a sink (no dependents)
5. A node with `iterate: false` may not depend on a node with `iterate: true` (its inputs would mutate across iterations)
6. `worktree: true` requires the fleet to be launched inside a git repo (checked at launch, not plan)
7. All v1 validations unchanged

## 5. Iteration loop (scheduler.ts)

```
runFleet(spec):
  for n in 1..max_iterations:
    if state.paused: break                        // boundary check, ruling 9
    reset: replay nodes → pending (fresh NodeState);
           run-once nodes keep iteration-1 result (n > 1)
    run DAG to all-terminal                       // existing v1 inner loop, unchanged
    snapshot → state.iterations[n]                // includes verdict + verdict_body
    archive iterations/<n>/workers/* outputs+prompts
    if killSwitch: status = killed; break
    if any node failed/contract_failed: status = failed; break   // ruling 6
    gate check:
      reviewer:
        reviewer contract_failed → status = failed; break        // ruling 7
        lgtm     → streak++; streak >= lgtm_count → status = completed; break
        iterate  → streak = 0; continue
        escalate → status = paused; notify operator; break
      none: continue
  if loop exhausted without completion: status = failed          // max_iterations hit
```

Rulings encoded: pause checked at boundary only (9); kill archives partial iteration (8); failures end the fleet, not just the iteration (6); reviewer contract failure is fleet-fatal (7).

`gate: "none"` loop end states: `completed` is unreachable — terminal states are `failed` (caps hit or node failure) or `killed`. Autoresearch fleets are expected to be killed or capped; this is by design ("NEVER STOP" pattern, operator owns termination).

## 6. Feedback injection (prompts.ts)

Iteration N > 1, replay nodes get, immediately after `## Task`:

```
## Reviewer feedback (iteration N-1)
<verdict_body from state.iterations[N-1]>
```

The reviewer node additionally gets:

```
## Previous reviews
### Iteration 1 — verdict: iterate
<body>
### Iteration 2 — verdict: lgtm
<body>
```

Sourced from `state.iterations` (ruling 11), never disk scraping. Prompts regenerated per dispatch; each iteration's prompt archived to `iterations/<n>/workers/<id>-prompt.md` (ruling 13). `workers/<id>/output/` copied to `iterations/<n>/workers/<id>/output/` at iteration end (ruling 12).

## 7. Worktree directive (prompts.ts)

Nodes with `worktree: true` get:

```
## Your worktree
Work inside your own git worktree, not the main checkout.
If it does not exist yet, create it:
  git worktree add <fleetRoot>/worktrees/<node-id> -b fleet/<fleet-ts>/<node-id>
If it already exists (iteration > 1), reuse it and your existing branch.
Make ALL repo changes inside the worktree. Commit your work there.
```

Upstream-inputs section gains, per dependency with `worktree: true`:

```
- <dep-id> worktree: <fleetRoot>/worktrees/<dep-id> (branch fleet/<fleet-ts>/<dep-id>)
  — merge or cherry-pick from here if you need its repo changes
```

Contract resolution change (ruling 15): repo-relative output paths of a `worktree: true` node resolve against `<fleetRoot>/worktrees/<node-id>` instead of `repoCwd`. `output/` paths unchanged (worker dir).

Conflict resolution is a DAG-design concern: fleets with overlapping edit areas add a **resolver node** downstream of the conflicting builders. Extension provides paths and conventions only — no merge machinery (ruling: extension runs zero git commands).

## 8. Pause/resume

- `fleet_pause` tool + `/fleet pause` → `state.paused = true`; takes effect at next iteration boundary
- `fleet_resume` tool + `/fleet resume` → clears flag; loop continues from `state.iteration`; streak preserved (ruling 10)
- `escalate` verdict → auto-pause + `ctx.ui.notify` warning
- Pause never interrupts running workers (ruling 9)

## 9. Widget and report

Widget header (loop fleets only):

```
● fleet: auth-research · iteration 2/5 · last verdict: iterate · streak 0/2 (2/3 done · $0.42)
```

Report gains:
- iteration table: `n | verdict | tokens | cost | duration`
- verdict bodies inlined per iteration
- per-iteration per-node detail sections
- worktree branch list when any node has `worktree: true`

`fleet_report` tool unchanged otherwise.

## 10. Cost

Cumulative across iterations (ruling 17). `warn_cost_usd` fires once on crossing, warning to orchestrator + widget indicator. **Known limitation (v1, out of scope):** cost estimate is token-only and currently reports $0.00 — `max_iterations` is the effective hard cap until per-model pricing lands.

## 11. Error handling additions

| failure | behavior |
|---|---|
| node failed/contract_failed in iteration N | v1 blocked-propagation; fleet `failed` at iteration end |
| reviewer contract_failed | fleet `failed` (gate unreadable) — ruling 7 |
| kill mid-iteration | partial iteration archived; fleet `killed` — ruling 8 |
| escalate verdict | fleet `paused`, operator notified |
| max_iterations exhausted (reviewer gate, no lgtm streak) | fleet `failed` |
| launch with `worktree: true` outside git repo | launch fails with clear error — validation rule 6 |

## 12. Ontology additions

Append-only to `docs/ontology.md`: **iteration** (activated from reserved), **loop**, **gate**, **lgtm streak**, **replay node**, **run-once node**, **feedback injection**, **review history**, **iteration boundary**, **paused** (fleet status), **escalate**, **worktree directive**, **fleet branch**, **resolver node**. `JIT node` stays reserved.

## 13. Testing

- Zero-API throughout via fake SessionFactory (v1 pattern)
- Scheduler loop: lgtm streak + stop, iterate resets streak, escalate → paused, max_iterations → failed, run-once carryover, pause at boundary, kill mid-iteration archives partial snapshot, reviewer contract_failed → failed
- Validation: all §4 rules
- Contracts: worktree path resolution for repo-relative outputs
- Prompts: feedback section, review history, worktree directive, upstream worktree listing (snapshot-style assertions)
- State: iteration snapshot round-trip, paused flag, streak persistence
- ONE live smoke at end: 3-node fleet (`builder-a` writes "123" to a file, `builder-b` writes "456", `reviewer` reviews), all `gpt-5.4`-class models, task designed so reviewer iterates once then lgtms, `max_iterations: 3`. Trivial tasks only — no heavy work

## 14. Implementation phasing

1. Schema + validation + ontology
2. State shape (iterations, paused, streak) + snapshot/archive
3. Scheduler loop + gate logic
4. Prompt injection (feedback, review history)
5. Worktree directive + contract path resolution
6. Pause/resume tools + commands
7. Widget + report
8. Live smoke + docs

Phases are sequential in one repo — no parallel implementers (shared tree).

## 15. Open items resolved during brainstorming

- Replay scope: per-node `iterate` flag (explicit, no type heuristics) ✓
- Reviewer context: full prior-review history injected; no git-diff injection (reviewer lacks bash; deferred) ✓
- Autoresearch gate: eval instructions in task text; extension owns no eval machinery; plateau/search deferred ✓
- State: per-iteration snapshots in state.json ✓
- Worktree: per-node flag, directive injection only, extension runs zero git; resolver nodes for conflicts ✓
- Pause: state field + boundary-only effect; escalate = auto-pause ✓
- Unified spec over iterative-only (one abstraction, phased build) ✓
