# Fleet Ontology

Precise vocabulary for this project. Use these terms exactly — in code, commits, specs, prompts, and conversation. Schema is **extensible**: new terms may be appended, existing terms must not be redefined.

## Domain terms

| term | definition |
|---|---|
| **fleet** | one DAG execution unit. Defined by `fleet.json`, rooted at `.fleet/<name>-<ts>/` |
| **node** | a worker definition in the DAG (fleet.json `workers[]` entry) |
| **worker** | a running (or ran) instance of a node — an in-process `AgentSession` |
| **edge** | a `depends_on` relation: dependent node waits for dependency to complete |
| **layer** | set of nodes with equal topo depth (Kahn's BFS layer). Nodes in a layer may run in parallel |
| **ready-queue** | nodes whose dependencies all reached `completed`; eligible for dispatch |
| **contract** | a node's declared `outputs[]` — what it must produce, for whom |
| **kind** | verification rule for one declared output: `markdown`, `file-exists`, `verdict`, `json`, `yaml` |
| **verdict** | reviewer output contract: `verdict: lgtm\|iterate\|escalate` line + actionable body |
| **state** | the single `state.json` — only lifecycle source of truth. Atomic writes |
| **node status** | `pending` → `ready` → `running` → terminal: `completed` \| `failed` \| `contract_failed` \| `killed` \| `blocked` |
| **blocked** | terminal status: node's dependency failed/was killed; node never runs |
| **fleet status** | `planned` → `running` → terminal: `completed` \| `failed` \| `killed` |
| **report** | machine-written `report.md` at fleet completion — the doc-skill bridge |
| **fleet-of-one** | single-node fleet. Same machinery, no special case |
| **worker-mode** | extension loaded into a worker session, scoped by node id; exposes `fleet_dag_read` + `fleet_node_update` |
| **orchestrator** | the main pi session that plans/launches/monitors the fleet |

## Reserved for v2 (defined now, unimplemented)

| term | definition |
|---|---|
| **iteration** | one full DAG pass in an iterative (reviewer-gated) fleet |
| **JIT node** | node appended to the DAG after launch |

## Commit message ontology

Format: `<type>: <imperative summary>` — summary ≤ 72 chars, lowercase after prefix.

| type | when |
|---|---|
| `add:` | new feature, file, or capability |
| `update:` | change existing behavior or content |
| `fix:` | correct a bug or error |
| `spec:` | design/spec documents |
| `test:` | tests only |
| `refactor:` | restructure, no behavior change |

Rules: one type per commit (split if two apply). No other types. Body optional, wrapped at 80.
