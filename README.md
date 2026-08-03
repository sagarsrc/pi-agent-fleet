# pi-agent-fleet

DAG-of-agents fleets for [pi](https://github.com/earendil-works/pi-coding-agent). Define a fleet of worker agents as data, preview it, launch it, watch it run — with per-worker output contracts, reviewer-gated iteration loops, live cost tracking, and a machine-written report.

```
● fleet: cost-relaunch-build · iteration 1/3 · last verdict: iterate · streak 0/1 (2/3 done · $1.42)
├─ ✓ builder-pricing (kimi-for-coding) · 32 turns · 945k tok · $0.83
├─ ⠹ builder-relaunch (kimi-for-coding) · 12 turns · 401k tok · editing src/scheduler.ts…
└─ ○ reviewer (k3) · waiting on builder-relaunch
```

## Why

One agent is a tool. A **fleet** is a workflow: researchers feed builders, builders feed reviewers, reviewers gate quality — all visible, all recorded, all contract-checked. Fleets run in-process via pi's SDK: any provider pi is logged into (Claude, Codex, Kimi, …) works per-node.

Philosophy: no auto-restart, no auto-kill, no babysitting. Failures surface; the operator decides. Contracts are checked at worker exit. The reviewer is the quality gate; you are the kill switch.

## Install

```bash
pi install npm:pi-agent-fleet                    # from npm
pi install git:github.com/sagarsrc/pi-agent-fleet # from git
pi install /path/to/pi-agent-fleet               # local
```

## Quickstart

Ask your pi session (the LLM drives the tools):

> Plan and launch a fleet: two parallel writers and a combiner, all gpt-5.4-mini.
> writer-a writes output/a.md containing "# 123", writer-b writes output/b.md containing "# 456",
> combiner (depends on both) writes output/sum.md with the total.
> Each declares its output as a markdown contract.

The agent calls `fleet_plan` (validates + ASCII preview), you confirm, `fleet_launch` runs it. Watch the live widget; read the report at `.fleet/<name>-<ts>/report.md`.

## Fleet modes

**One-shot DAG** — static dependency graph, parallel layers, contracts at exit:

```json
{
  "fleet_name": "auth-research",
  "type": "dag",
  "config": { "max_concurrent": 4, "model": "gpt-5.4-mini" },
  "workers": [
    { "id": "research", "type": "research", "task": "…",
      "outputs": [{ "path": "output/findings.md", "kind": "markdown", "required": true }] },
    { "id": "build", "type": "code-run", "task": "…", "depends_on": ["research"],
      "outputs": [{ "path": "src/auth/login.ts", "kind": "file-exists", "required": true }] }
  ]
}
```

**Iterative fleet** — reviewer-gated replay until quality passes:

```json
{
  "config": {
    "loop": { "gate": "reviewer", "max_iterations": 5, "lgtm_count": 2 }
  }
}
```

A reviewer node writes a verdict contract (`verdict: lgtm | iterate | escalate` + actionable body). `iterate` → builders get the review injected as feedback next iteration. `lgtm` × `lgtm_count` consecutive → completed. `escalate` → fleet pauses and notifies you. `gate: "none"` → free-running loop (autoresearch pattern: eval instructions live in the worker's task text).

**Worktree mode** — `worktree: true` on a node: the worker runs in a dedicated git worktree on a deterministic branch (`fleet/<fleet-name>/<node-id>`). The extension creates the worktree, commits the worker's changes, and, when two or more worktree workers exist, auto-injects a `fleet-integrator` node that merges their branches in dependency order before the agent runs. Overlapping repo-relative output paths without an ordered handoff are rejected at plan time. Merge conflicts surface as a failed integrator with a `status_note` listing the files, so the operator can resolve and relaunch.

**Run-once vs replay nodes** — `iterate: false`: node runs at iteration 1 only, outputs carry over (e.g. research that doesn't change).

## Contracts

Every worker declares `outputs[]` with kinds, verified in code at worker exit before dependents are released:

| kind | check |
|---|---|
| `markdown` | exists, non-empty, starts with `#` |
| `file-exists` | exists, non-empty (repo-relative paths = code edits) |
| `verdict` | `verdict: lgtm\|iterate\|escalate` line + non-empty body |
| `json` / `yaml` | parses |

Failed required contract → `contract_failed`, dependents blocked, orchestrator notified. No silent passes.

## Tools & commands

| tool | purpose |
|---|---|
| `fleet_plan` | validate + preview a fleet definition (no launch) |
| `fleet_launch` | launch (confirm gate, `skip_confirm` for unattended) |
| `fleet_status` | live DAG status |
| `fleet_pause` / `fleet_resume` | pause/resume loop fleets at iteration boundary |
| `fleet_relaunch` | re-run a failed node (+ blocked downstream), optional model override |
| `fleet_kill` | fleet-wide kill |
| `fleet_report` | regenerate report.md |
| `fleet_canvas` | open browser canvas; `?demo=1` shows synthetic data for UI iteration |

`/fleet viz | status | clear | pause | resume | relaunch <id> [model] | kill all | canvas [open|url|stop]`

## Records

Everything lands in `.fleet/<name>-<ts>/` (git-ignored): `state.json` (single source of truth, atomic writes), per-worker `prompt.md` + `session.jsonl` + outputs, per-iteration archives, and a machine-written `report.md` with per-worker turns/tokens/cost, contract results, verdict history, and git diff stats.

## Model selection

Fleet-wide default via `config.model`; per-node override via `worker.model`. Any model pi can resolve — including any provider pi is logged into. Cheap models for trivial writers, strong models for reviewers:

```json
{ "id": "reviewer", "type": "reviewer", "model": "kimi-coding/k3", … }
```

## Development

```bash
npm install
npm test          # 232 tests, zero-API (fake session factory)
npm run typecheck
```

Design docs live in `docs/superpowers/specs/`; experiment history in `docs/experiments/`.

## License

MIT
