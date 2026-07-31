# pi-fleet-extension

DAG-of-agents fleet extension for `pi`.

Plan a static DAG of worker agents, preview it, launch it, and get a machine-written `report.md` when it finishes. Each worker has output contracts verified at exit, and dependent nodes wait until upstream contracts pass.

- Design: [docs/superpowers/specs/2026-08-01-fleet-extension-design.md](docs/superpowers/specs/2026-08-01-fleet-extension-design.md)
- Vocabulary: [docs/ontology.md](docs/ontology.md)

## Install

Development mode loads the extension directly from this repo:

```bash
pi -e ./src/index.ts
```

After publishing, install as a normal pi package:

```bash
pi install pi-fleet-extension
```

## Usage

Write a `fleet.json` with a `dag` fleet, a `config`, and a list of `workers`.
See [`examples/two-worker-fleet.json`](examples/two-worker-fleet.json) for a minimal smoke example.

In a pi session, use the registered tools:

- `fleet_plan` — validate a fleet definition, create `.fleet/<name>-<ts>/`, and return an ASCII DAG preview. Does not launch.
- `fleet_launch` — launch the planned fleet. In TUI mode this asks for confirmation; in headless mode (`pi -p`) it proceeds without confirmation.
- `fleet_status` — show the current DAG and per-node progress.
- `fleet_report` — regenerate the markdown report from the current state.
- `fleet_kill` — request fleet-wide kill (single-node kill is deferred to v2).

User commands:

- `/fleet viz` — render the ASCII DAG into the widget.
- `/fleet status` — show the live status table in the widget.
- `/fleet clear` — dismiss the widget.
- `/fleet kill all` — kill the whole fleet.

When the fleet finishes, read `.fleet/<name>-<ts>/report.md` for the summary, node table, contracts, and artifacts list.

## Example smoke command

```bash
pi -e ./src/index.ts -p "Plan and launch the fleet defined in examples/two-worker-fleet.json, then report status when done."
```

This runs two tiny `write` workers with `openai-codex/gpt-5.4-mini` and produces `.fleet/smoke-*/report.md`.

## Testing economics

- Unit tests and the end-to-end pipeline test use zero live API calls: they inject fake sessions and run the real scheduler + contracts + report path.
- The live smoke test uses one cheap model run (`gpt-5.4-mini`) with trivial tasks; no retries unless the first run fails.

```bash
npm test
npm run typecheck
```
