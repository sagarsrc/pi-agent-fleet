# Fleet Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `fleet`, a pi extension that plans, previews, launches, and monitors a static DAG of in-process worker agents with per-node output contracts and machine-written reports.

**Architecture:** Pure-TypeScript DAG core (parse/validate/topo/contracts/state — vitest unit tested, no pi runtime), a worker runtime wrapping `createAgentSession` (tintin pi-subagents pattern), a ready-queue scheduler, and an extension entry wiring LLM tools + user commands + TUI widget. Spec: `docs/superpowers/specs/2026-08-01-fleet-extension-design.md`. Vocabulary: `docs/ontology.md` — use its terms exactly.

**Tech Stack:** TypeScript (ESM), vitest, `@earendil-works/pi-coding-agent` SDK (`createAgentSession`, `defineTool`, `SessionManager`), `typebox`.

## Global Constraints

- Commit format per `docs/ontology.md`: `add:` / `update:` / `fix:` / `spec:` / `test:` / `refactor:` — imperative, ≤72 chars
- Ontology terms exact: node, worker, contract, kind, verdict, ready-queue, blocked, fleet-of-one, report
- Fleet root: `.fleet/<short-name>-<yyyymmdd-hhmmss>/`; `.fleet/.gitignore` contains `*`
- State: single `state.json` per fleet root, atomic write (tmp + rename). NO sentinel files
- No auto-retry, no auto-restart anywhere. Failures surface; operator decides
- pi-only workers, in-process `createAgentSession` — no tmux, no `pi -p` subprocess
- Every worker prompt MUST end with: `Save ALL output files to <FLEET_ROOT>/workers/<id>/output/ — use absolute paths.` (unless the output is a repo-relative code file — one destination rule per spec §6)
- Contract kinds: `markdown`, `file-exists`, `verdict`, `json`, `yaml` — verified at worker exit
- Worker tool allowlists by type (pi built-in names): `research` → `read,grep,find,ls,write,web_search,fetch_content`; `code-run` → `read,bash,edit,write,grep,find,ls`; `reviewer` → `read,write,grep,find,ls`; `write` → `read,write,grep,find,ls`; `read-only` → `read,grep,find,ls`

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: `npm test` runs vitest; `npm run typecheck` runs `tsc --noEmit`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "pi-fleet-extension",
  "version": "0.1.0",
  "description": "DAG-of-agents fleet extension for pi",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.80.0",
    "@earendil-works/pi-ai": ">=0.80.0"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.0",
    "@earendil-works/pi-ai": "^0.80.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write vitest.config.ts and .gitignore**

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

```
node_modules/
.fleet/
dist/
```

- [ ] **Step 4: Install and verify**

Run: `npm install && npm run typecheck`
Expected: exit 0 (no source yet — tsc reports no inputs; if it errors on empty include, add `src/placeholder.ts` with `export {}`)

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore package-lock.json
git commit -m "add: project scaffolding (typescript, vitest, pi package)"
```

---

### Task 2: Core types (`src/types.ts`)

**Files:**
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Produces (all tasks consume these exact names):
  - `OutputKind`, `ContractOutput`, `WorkerType`, `WorkerSpec`, `FleetConfig`, `FleetSpec`
  - `NodeStatus`, `TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus>`, `FleetStatus`
  - `ContractCheck`, `ContractResult`, `NodeState`, `FleetState`
  - `WORKER_TYPE_TOOLS: Record<WorkerType, string[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/types.test.ts
import { describe, expect, it } from "vitest";
import { TERMINAL_NODE_STATUSES, WORKER_TYPE_TOOLS } from "../src/types.js";

describe("types", () => {
  it("terminal statuses match ontology", () => {
    expect([...TERMINAL_NODE_STATUSES].sort()).toEqual(
      ["blocked", "completed", "contract_failed", "failed", "killed"],
    );
  });
  it("every worker type has a tool allowlist", () => {
    for (const t of ["research", "code-run", "reviewer", "write", "read-only"] as const) {
      expect(WORKER_TYPE_TOOLS[t].length).toBeGreaterThan(0);
    }
    expect(WORKER_TYPE_TOOLS["read-only"]).not.toContain("write");
    expect(WORKER_TYPE_TOOLS.research).toContain("web_search");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/types.js'`

- [ ] **Step 3: Write src/types.ts**

```typescript
export type OutputKind = "markdown" | "file-exists" | "verdict" | "json" | "yaml";

export interface ContractOutput {
  path: string;
  kind: OutputKind;
  required: boolean;
}

export type WorkerType = "research" | "code-run" | "reviewer" | "write" | "read-only";

export interface WorkerSpec {
  id: string;
  type: WorkerType;
  task: string;
  model?: string;
  depends_on: string[];
  outputs: ContractOutput[];
}

export interface FleetConfig {
  max_concurrent: number;
  model: string;
  warn_cost_usd?: number;
}

export interface FleetSpec {
  fleet_name: string;
  type: "dag";
  config: FleetConfig;
  workers: WorkerSpec[];
}

export type NodeStatus =
  | "pending" | "ready" | "running"
  | "completed" | "failed" | "contract_failed" | "killed" | "blocked";

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  "completed", "failed", "contract_failed", "killed", "blocked",
]);

export type FleetStatus = "planned" | "running" | "completed" | "failed" | "killed";

export interface ContractCheck {
  path: string;
  kind: OutputKind;
  required: boolean;
  ok: boolean;
  error?: string;
}

export interface ContractResult {
  ok: boolean;
  checks: ContractCheck[];
}

export interface NodeState {
  status: NodeStatus;
  started_at?: string;
  ended_at?: string;
  turns: number;
  tokens: number;
  cost_usd_estimate: number;
  contract_result?: ContractResult;
  produced_outputs: string[];
  status_note?: string;
}

export interface FleetState {
  fleet_name: string;
  status: FleetStatus;
  created_at: string;
  cost_usd_estimate: number;
  nodes: Record<string, NodeState>;
}

export const WORKER_TYPE_TOOLS: Record<WorkerType, string[]> = {
  "research": ["read", "grep", "find", "ls", "write", "web_search", "fetch_content"],
  "code-run": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "reviewer": ["read", "write", "grep", "find", "ls"],
  "write": ["read", "write", "grep", "find", "ls"],
  "read-only": ["read", "grep", "find", "ls"],
};
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.ts
git commit -m "add: core domain types per ontology"
```

---

### Task 3: DAG parse/validate/topo (`src/dag.ts`)

**Files:**
- Create: `src/dag.ts`
- Test: `test/dag.test.ts`

**Interfaces:**
- Consumes: `FleetSpec` from `src/types.ts`
- Produces:
  - `validateFleetSpec(raw: unknown): { ok: true; spec: FleetSpec; layers: string[][] } | { ok: false; errors: string[] }`
  - `topoLayers(spec: FleetSpec): string[][]` — Kahn's BFS layers; throws `CycleError` (exported class, `.remaining: string[]`)
  - `getDependents(spec: FleetSpec, nodeId: string): string[]`

Validation rules: fleet_name non-empty kebab-case; ≥1 worker; unique ids; `depends_on` references exist; worker id regex `^[a-z0-9][a-z0-9-]*$`; type in enum; outputs kinds in enum; config.max_concurrent ≥1 (default 4); config.model default `"k2p6"`; `depends_on` defaults `[]`; `outputs` defaults `[]`. Cycle → `ok:false` with `CYCLE:a,b` in errors.

- [ ] **Step 1: Write the failing test**

```typescript
// test/dag.test.ts
import { describe, expect, it } from "vitest";
import { getDependents, topoLayers, validateFleetSpec } from "../src/dag.js";

const base = {
  fleet_name: "t-fleet",
  type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "code-run", task: "t", depends_on: ["a"], outputs: [] },
    { id: "c", type: "reviewer", task: "t", depends_on: ["a"], outputs: [] },
    { id: "d", type: "write", task: "t", depends_on: ["b", "c"], outputs: [] },
  ],
};

describe("validateFleetSpec", () => {
  it("accepts a valid fleet and computes layers", () => {
    const r = validateFleetSpec(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layers).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("rejects unknown dependency", () => {
    const bad = structuredClone(base);
    bad.workers[1].depends_on = ["nope"];
    const r = validateFleetSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("nope");
  });
  it("rejects cycles with CYCLE: prefix", () => {
    const bad = structuredClone(base);
    bad.workers[0].depends_on = ["d"];
    const r = validateFleetSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/CYCLE:/);
  });
  it("rejects duplicate ids and bad worker id format", () => {
    const dup = structuredClone(base);
    dup.workers.push(dup.workers[0]);
    expect(validateFleetSpec(dup).ok).toBe(false);
    const badId = structuredClone(base);
    badId.workers[0].id = "Bad_Id";
    expect(validateFleetSpec(badId).ok).toBe(false);
  });
  it("applies defaults", () => {
    const min = { fleet_name: "f", type: "dag", config: {}, workers: [{ id: "a", type: "write", task: "t" }] };
    const r = validateFleetSpec(min);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.config.max_concurrent).toBe(4);
      expect(r.spec.workers[0].depends_on).toEqual([]);
      expect(r.spec.workers[0].outputs).toEqual([]);
    }
  });
});

describe("getDependents", () => {
  it("returns direct dependents", () => {
    const r = validateFleetSpec(base);
    if (!r.ok) throw new Error("unreachable");
    expect(getDependents(r.spec, "a").sort()).toEqual(["b", "c"]);
    expect(getDependents(r.spec, "d")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/dag.ts**

```typescript
import type { FleetSpec, OutputKind, WorkerSpec, WorkerType } from "./types.js";

export class CycleError extends Error {
  constructor(public remaining: string[]) {
    super(`CYCLE:${remaining.join(",")}`);
    this.name = "CycleError";
  }
}

const WORKER_TYPES: WorkerType[] = ["research", "code-run", "reviewer", "write", "read-only"];
const KINDS: OutputKind[] = ["markdown", "file-exists", "verdict", "json", "yaml"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function topoLayers(spec: FleetSpec): string[][] {
  const ids = spec.workers.map((w) => w.id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const rev = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const w of spec.workers) {
    for (const d of w.depends_on) {
      indeg.set(w.id, (indeg.get(w.id) ?? 0) + 1);
      rev.get(d)?.push(w.id);
    }
  }
  const layers: string[][] = [];
  let current = ids.filter((id) => indeg.get(id) === 0);
  let placed = 0;
  while (current.length > 0) {
    layers.push(current);
    placed += current.length;
    const next: string[] = [];
    for (const n of current) {
      for (const m of rev.get(n) ?? []) {
        const v = (indeg.get(m) ?? 0) - 1;
        indeg.set(m, v);
        if (v === 0) next.push(m);
      }
    }
    current = next;
  }
  if (placed !== ids.length) {
    throw new CycleError(ids.filter((id) => !layers.flat().includes(id)));
  }
  return layers;
}

export function getDependents(spec: FleetSpec, nodeId: string): string[] {
  return spec.workers.filter((w) => w.depends_on.includes(nodeId)).map((w) => w.id);
}

export function validateFleetSpec(
  raw: unknown,
): { ok: true; spec: FleetSpec; layers: string[][] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const r = raw as Record<string, unknown>;
  if (typeof r?.fleet_name !== "string" || !ID_RE.test(r.fleet_name)) {
    errors.push("fleet_name must be non-empty kebab-case");
  }
  if (r?.type !== "dag") errors.push('type must be "dag"');
  const cfg = (r?.config ?? {}) as Record<string, unknown>;
  const maxConcurrent = typeof cfg.max_concurrent === "number" ? cfg.max_concurrent : 4;
  if (maxConcurrent < 1) errors.push("config.max_concurrent must be >= 1");
  const model = typeof cfg.model === "string" ? cfg.model : "k2p6";
  const warnCost = typeof cfg.warn_cost_usd === "number" ? cfg.warn_cost_usd : undefined;

  const rawWorkers = Array.isArray(r?.workers) ? (r.workers as Record<string, unknown>[]) : [];
  if (rawWorkers.length === 0) errors.push("at least one worker required");

  const seen = new Set<string>();
  const workers: WorkerSpec[] = [];
  for (const w of rawWorkers) {
    const id = typeof w.id === "string" ? w.id : "";
    if (!ID_RE.test(id)) errors.push(`worker id "${id}" must match ${ID_RE}`);
    if (seen.has(id)) errors.push(`duplicate worker id "${id}"`);
    seen.add(id);
    const type = w.type as WorkerType;
    if (!WORKER_TYPES.includes(type)) errors.push(`worker "${id}": bad type "${String(w.type)}"`);
    if (typeof w.task !== "string" || w.task.length === 0) errors.push(`worker "${id}": task required`);
    const outputs = (Array.isArray(w.outputs) ? w.outputs : []) as Record<string, unknown>[];
    for (const o of outputs) {
      if (!KINDS.includes(o.kind as OutputKind)) errors.push(`worker "${id}": bad output kind "${String(o.kind)}"`);
      if (typeof o.path !== "string" || o.path.length === 0) errors.push(`worker "${id}": output path required`);
    }
    workers.push({
      id,
      type,
      task: String(w.task ?? ""),
      model: typeof w.model === "string" ? w.model : undefined,
      depends_on: Array.isArray(w.depends_on) ? (w.depends_on as string[]) : [],
      outputs: outputs.map((o) => ({ path: String(o.path), kind: o.kind as OutputKind, required: o.required !== false })),
    });
  }
  const idSet = new Set(workers.map((w) => w.id));
  for (const w of workers) {
    for (const d of w.depends_on) {
      if (!idSet.has(d)) errors.push(`worker "${w.id}": unknown dependency "${d}"`);
    }
  }

  const spec: FleetSpec = {
    fleet_name: String(r?.fleet_name ?? ""),
    type: "dag",
    config: { max_concurrent: maxConcurrent, model, warn_cost_usd: warnCost },
    workers,
  };

  let layers: string[][] = [];
  if (errors.length === 0) {
    try {
      layers = topoLayers(spec);
    } catch (e) {
      if (e instanceof CycleError) errors.push(e.message);
      else throw e;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec, layers };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dag.ts test/dag.test.ts
git commit -m "add: dag validation and kahn topo layers with cycle detection"
```

---

### Task 4: Contract verifiers (`src/contracts.ts`)

**Files:**
- Create: `src/contracts.ts`
- Test: `test/contracts.test.ts`
- Create: `test/fixtures/` (fixture files written by tests at runtime into tmp dirs — no static fixtures)

**Interfaces:**
- Consumes: `ContractOutput`, `ContractResult`, `ContractCheck` from `src/types.ts`
- Produces:
  - `verifyOutputs(opts: { workerDir: string; repoCwd: string; outputs: ContractOutput[] }): Promise<ContractResult>`
  - Path resolution: outputs starting with `output/` resolve under `workerDir`; everything else resolves under `repoCwd`

Kind rules: `markdown` = exists + non-empty + first non-blank line starts with `#`. `file-exists` = exists + size > 0. `verdict` = exists + matches `/^verdict:\s*(lgtm|iterate|escalate)\s*$/m` + has non-whitespace content after the verdict line. `json` = exists + `JSON.parse` ok. `yaml` = exists + naive parse check (non-empty + no tab-indent error; use `yaml` npm pkg if present — **decision: hand-rolled minimal check, no new dep**: file non-empty and every line matches `^\s*(-\s)?[\w"']+.*` or is blank/comment).

`result.ok` = all required checks pass. Optional failures appear in `checks` with `ok:false` but don't fail result.

- [ ] **Step 1: Write the failing test**

```typescript
// test/contracts.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyOutputs } from "../src/contracts.js";

async function setup(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "fleet-test-"));
  const workerDir = join(root, "worker");
  const repoCwd = join(root, "repo");
  await mkdir(join(workerDir, "output"), { recursive: true });
  await mkdir(join(repoCwd, "src"), { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    const full = p.startsWith("output/") ? join(workerDir, p) : join(repoCwd, p);
    await writeFile(full, content);
  }
  return { workerDir, repoCwd };
}

describe("verifyOutputs", () => {
  it("passes valid markdown in output/", async () => {
    const { workerDir, repoCwd } = await setup({ "output/findings.md": "# Findings\nbody" });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [{ path: "output/findings.md", kind: "markdown", required: true }] });
    expect(r.ok).toBe(true);
  });
  it("fails markdown without heading", async () => {
    const { workerDir, repoCwd } = await setup({ "output/bad.md": "no heading" });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [{ path: "output/bad.md", kind: "markdown", required: true }] });
    expect(r.ok).toBe(false);
  });
  it("file-exists resolves repo-relative paths", async () => {
    const { workerDir, repoCwd } = await setup({ "src/login.ts": "export const x = 1;" });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [{ path: "src/login.ts", kind: "file-exists", required: true }] });
    expect(r.ok).toBe(true);
  });
  it("verdict requires verdict line and body", async () => {
    const good = await setup({ "output/review.md": "verdict: iterate\n\n## builder\n1. fix src/a.ts line 3" });
    expect((await verifyOutputs({ workerDir: good.workerDir, repoCwd: good.repoCwd, outputs: [{ path: "output/review.md", kind: "verdict", required: true }] })).ok).toBe(true);
    const noBody = await setup({ "output/review.md": "verdict: lgtm\n" });
    expect((await verifyOutputs({ workerDir: noBody.workerDir, repoCwd: noBody.repoCwd, outputs: [{ path: "output/review.md", kind: "verdict", required: true }] })).ok).toBe(false);
  });
  it("json must parse; optional missing does not fail", async () => {
    const { workerDir, repoCwd } = await setup({ "output/data.json": '{"a":1}' });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [
      { path: "output/data.json", kind: "json", required: true },
      { path: "output/missing.md", kind: "markdown", required: false },
    ] });
    expect(r.ok).toBe(true);
    expect(r.checks[1].ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/contracts.ts**

```typescript
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ContractCheck, ContractOutput, ContractResult } from "./types.js";

const VERDICT_RE = /^verdict:\s*(lgtm|iterate|escalate)\s*$/m;

function resolvePath(workerDir: string, repoCwd: string, p: string): string {
  if (isAbsolute(p)) return p;
  return p.startsWith("output/") ? join(workerDir, p) : join(repoCwd, p);
}

async function checkOne(workerDir: string, repoCwd: string, o: ContractOutput): Promise<ContractCheck> {
  const full = resolvePath(workerDir, repoCwd, o.path);
  const fail = (error: string): ContractCheck => ({ path: o.path, kind: o.kind, required: o.required, ok: false, error });
  let content: string;
  try {
    const s = await stat(full);
    if (o.kind === "file-exists") {
      return s.size > 0
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("empty file");
    }
    content = await readFile(full, "utf-8");
  } catch {
    return fail("file not found");
  }
  switch (o.kind) {
    case "markdown": {
      const first = content.split("\n").find((l) => l.trim().length > 0) ?? "";
      return first.startsWith("#")
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("no markdown heading");
    }
    case "verdict": {
      const m = content.match(VERDICT_RE);
      if (!m) return fail("no verdict line");
      const body = content.slice(content.indexOf(m[0]) + m[0].length).trim();
      return body.length > 0
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("verdict line without body");
    }
    case "json":
      try {
        JSON.parse(content);
        return { path: o.path, kind: o.kind, required: o.required, ok: true };
      } catch (e) {
        return fail(`json parse error: ${(e as Error).message}`);
      }
    case "yaml": {
      const bad = content.split("\n").some((l) => l.includes("\t"));
      return content.trim().length > 0 && !bad
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("empty or invalid yaml");
    }
    default:
      return fail(`unknown kind`);
  }
}

export async function verifyOutputs(opts: {
  workerDir: string;
  repoCwd: string;
  outputs: ContractOutput[];
}): Promise<ContractResult> {
  const checks = await Promise.all(opts.outputs.map((o) => checkOne(opts.workerDir, opts.repoCwd, o)));
  const ok = checks.every((c) => !c.required || c.ok);
  return { ok, checks };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts test/contracts.test.ts
git commit -m "add: contract verifiers for output kinds"
```

---

### Task 5: State management (`src/state.ts`)

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `FleetSpec`, `FleetState`, `NodeState` from `src/types.ts`
- Produces:
  - `initFleetState(spec: FleetSpec): FleetState` — all nodes `pending`, zeroed counters, `status: "planned"`
  - `readState(fleetRoot: string): Promise<FleetState>`
  - `writeState(fleetRoot: string, state: FleetState): Promise<void>` — atomic (tmp + rename)
  - `patchNode(fleetRoot: string, state: FleetState, nodeId: string, patch: Partial<NodeState>): FleetState` — pure: returns new state object with node patched + fleet `cost_usd_estimate` recomputed as sum of node costs. Caller persists via `writeState`

- [ ] **Step 1: Write the failing test**

```typescript
// test/state.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initFleetState, patchNode, readState, writeState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [{ id: "a", type: "write", task: "t", depends_on: [], outputs: [] }],
};

describe("state", () => {
  it("init -> write -> read roundtrip", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-state-"));
    const s = initFleetState(spec);
    expect(s.status).toBe("planned");
    expect(s.nodes.a.status).toBe("pending");
    await writeState(root, s);
    const back = await readState(root);
    expect(back).toEqual(s);
    const raw = await readFile(join(root, "state.json"), "utf-8");
    expect(JSON.parse(raw).fleet_name).toBe("t");
  });
  it("patchNode is pure and recomputes fleet cost", async () => {
    const s = initFleetState(spec);
    const s2 = patchNode("/unused", s, "a", { status: "completed", cost_usd_estimate: 0.5 });
    expect(s.nodes.a.status).toBe("pending");
    expect(s2.nodes.a.status).toBe("completed");
    expect(s2.cost_usd_estimate).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/state.ts**

```typescript
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FleetSpec, FleetState, NodeState } from "./types.js";

export function initFleetState(spec: FleetSpec): FleetState {
  const nodes: Record<string, NodeState> = {};
  for (const w of spec.workers) {
    nodes[w.id] = { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };
  }
  return {
    fleet_name: spec.fleet_name,
    status: "planned",
    created_at: new Date().toISOString(),
    cost_usd_estimate: 0,
    nodes,
  };
}

export async function readState(fleetRoot: string): Promise<FleetState> {
  return JSON.parse(await readFile(join(fleetRoot, "state.json"), "utf-8")) as FleetState;
}

export async function writeState(fleetRoot: string, state: FleetState): Promise<void> {
  const tmp = join(fleetRoot, `.state.json.tmp`);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(tmp, join(fleetRoot, "state.json"));
}

export function patchNode(
  _fleetRoot: string,
  state: FleetState,
  nodeId: string,
  patch: Partial<NodeState>,
): FleetState {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`unknown node "${nodeId}"`);
  const nodes = { ...state.nodes, [nodeId]: { ...node, ...patch } };
  const cost = Object.values(nodes).reduce((sum, n) => sum + n.cost_usd_estimate, 0);
  return { ...state, nodes, cost_usd_estimate: cost };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "add: atomic state.json management"
```

---

### Task 6: ASCII DAG renderer (`src/viz.ts`)

**Files:**
- Create: `src/viz.ts`
- Test: `test/viz.test.ts`

**Interfaces:**
- Consumes: `FleetSpec`, `FleetState`, `topoLayers` from earlier tasks
- Produces:
  - `renderDag(spec: FleetSpec, state?: FleetState): string` — layered columns; each node box shows id + status icon when state given (`✓ completed`, `✗ failed|contract_failed`, `◌ running`, `○ pending|ready`, `⊘ blocked|killed`); edges as `--▶` between layers
  - `dagNeedsFileFallback(spec: FleetSpec, termWidth: number): boolean` — true if > 15 nodes or rendered width > termWidth

Layout (simple, deterministic): one column per layer, nodes stacked vertically in layer order, edges listed below the columns as `from --▶ to` lines. (dag-viz.py uses the same list-edges-below approach — port the semantics, not box-drawing art.)

- [ ] **Step 1: Write the failing test**

```typescript
// test/viz.test.ts
import { describe, expect, it } from "vitest";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { dagNeedsFileFallback, renderDag } from "../src/viz.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "research", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "build", type: "code-run", task: "t", depends_on: ["research"], outputs: [] },
    { id: "review", type: "reviewer", task: "t", depends_on: ["build"], outputs: [] },
  ],
};

describe("renderDag", () => {
  it("renders layers and edges", () => {
    const out = renderDag(spec);
    expect(out).toContain("research");
    expect(out).toContain("build");
    expect(out).toContain("research --▶ build");
    expect(out).toContain("build --▶ review");
  });
  it("annotates statuses when state given", () => {
    const s = initFleetState(spec);
    s.nodes.research.status = "completed";
    s.nodes.build.status = "running";
    const out = renderDag(spec, s);
    expect(out).toContain("✓ research");
    expect(out).toContain("◌ build");
  });
  it("flags fallback for wide graphs", () => {
    expect(dagNeedsFileFallback(spec, 200)).toBe(false);
    const many: FleetSpec = structuredClone(spec);
    for (let i = 0; i < 20; i++) {
      many.workers.push({ id: `w-${i}`, type: "write", task: "t", depends_on: [], outputs: [] });
    }
    expect(dagNeedsFileFallback(many, 200)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/viz.ts**

```typescript
import { topoLayers } from "./dag.js";
import type { FleetSpec, FleetState, NodeStatus } from "./types.js";

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "◌", blocked: "⊘", killed: "⊘",
  pending: "○", ready: "○",
};

export function renderDag(spec: FleetSpec, state?: FleetState): string {
  const layers = topoLayers(spec);
  const label = (id: string): string => {
    const st = state?.nodes[id]?.status;
    return st ? `${ICON[st]} ${id}` : id;
  };
  const lines: string[] = [];
  const header = layers.map((l, i) => `layer ${i}: ${l.map(label).join("  ")}`).join("\n");
  lines.push(header, "", "edges:");
  for (const w of spec.workers) {
    for (const d of w.depends_on) lines.push(`  ${d} --▶ ${w.id}`);
  }
  if (spec.workers.every((w) => w.depends_on.length === 0)) lines.push("  (none — all parallel)");
  return lines.join("\n");
}

export function dagNeedsFileFallback(spec: FleetSpec, termWidth: number): boolean {
  if (spec.workers.length > 15) return true;
  const layers = topoLayers(spec);
  const widest = Math.max(...layers.map((l) => l.join("  ").length + 9));
  return widest > termWidth;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/viz.ts test/viz.test.ts
git commit -m "add: ascii dag renderer with status icons"
```

---

### Task 7: Worker prompt assembly (`src/prompts.ts`)

**Files:**
- Create: `src/prompts.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Consumes: `FleetSpec`, `FleetState`, `WorkerSpec`, `renderDag`, `getDependents`
- Produces:
  - `buildWorkerPrompt(opts: { spec: FleetSpec; state: FleetState; workerId: string; fleetRoot: string }): string`

Prompt sections, in order:
1. `# Fleet worker: <id>` + type + task
2. `## The fleet DAG` — `renderDag(spec)` output + one line per other node: `- <id> (<type>): <task>`
3. `## Your upstream inputs` — for each dep: `- <dep-id>: <abs path>` for each of the dep's declared outputs, resolved: `output/...` → `<fleetRoot>/workers/<dep-id>/output/...`, else `<repoCwd>`-relative left as-is
4. `## What downstream nodes need from you` — dependents (via `getDependents`) + this node's declared outputs list; if no dependents: "No downstream nodes — your outputs terminate the DAG."
5. `## Your output obligations` — table of declared outputs (path, kind, required) + the mandatory save line: `Save ALL output files to <fleetRoot>/workers/<id>/output/ — use absolute paths.` (only when ≥1 output path starts with `output/`); for repo-relative outputs: `Write code changes directly at their repo paths.`

- [ ] **Step 1: Write the failing test**

```typescript
// test/prompts.test.ts
import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../src/prompts.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "research", type: "research", task: "Research auth", depends_on: [],
      outputs: [{ path: "output/findings.md", kind: "markdown", required: true }] },
    { id: "build", type: "code-run", task: "Build login", depends_on: ["research"],
      outputs: [{ path: "src/auth/login.ts", kind: "file-exists", required: true }] },
  ],
};

describe("buildWorkerPrompt", () => {
  const state = initFleetState(spec);
  it("gives upstream node its obligations and downstream awareness", () => {
    const p = buildWorkerPrompt({ spec, state, workerId: "research", fleetRoot: "/f" });
    expect(p).toContain("# Fleet worker: research");
    expect(p).toContain("Research auth");
    expect(p).toContain("build");                       // DAG awareness
    expect(p).toContain("output/findings.md");          // own obligation
    expect(p).toContain("/f/workers/research/output/"); // mandatory save line
  });
  it("gives downstream node resolved upstream paths", () => {
    const p = buildWorkerPrompt({ spec, state, workerId: "build", fleetRoot: "/f" });
    expect(p).toContain("/f/workers/research/output/findings.md");
    expect(p).toContain("src/auth/login.ts");
    expect(p).toContain("Write code changes directly at their repo paths");
    expect(p).not.toContain("/f/workers/build/output/ — use absolute paths");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/prompts.ts**

```typescript
import { getDependents } from "./dag.js";
import type { FleetSpec, FleetState } from "./types.js";
import { renderDag } from "./viz.js";

export function buildWorkerPrompt(opts: {
  spec: FleetSpec;
  state: FleetState;
  workerId: string;
  fleetRoot: string;
}): string {
  const { spec, state, workerId, fleetRoot } = opts;
  const worker = spec.workers.find((w) => w.id === workerId);
  if (!worker) throw new Error(`unknown worker "${workerId}"`);
  const workerDir = `${fleetRoot}/workers/${workerId}`;
  const deps = spec.workers.filter((w) => worker.depends_on.includes(w.id));
  const dependents = getDependents(spec, workerId);
  const out: string[] = [];

  out.push(`# Fleet worker: ${workerId}`, "", `Type: ${worker.type}`, "", `## Task`, "", worker.task, "");

  out.push("## The fleet DAG", "", "```", renderDag(spec), "```", "");
  for (const w of spec.workers) {
    if (w.id !== workerId) out.push(`- ${w.id} (${w.type}): ${w.task}`);
  }
  out.push("");

  out.push("## Your upstream inputs", "");
  if (deps.length === 0) {
    out.push("No upstream dependencies — you are a layer-0 node.", "");
  } else {
    for (const d of deps) {
      if (d.outputs.length === 0) out.push(`- ${d.id}: (no declared outputs — read its session notes in ${fleetRoot}/workers/${d.id}/output/ if present)`);
      for (const o of d.outputs) {
        const abs = o.path.startsWith("output/")
          ? `${fleetRoot}/workers/${d.id}/${o.path}`
          : o.path;
        out.push(`- ${d.id}: ${abs} (${o.kind})`);
      }
    }
    out.push("");
  }

  out.push("## What downstream nodes need from you", "");
  if (dependents.length === 0) {
    out.push("No downstream nodes — your outputs terminate the DAG.", "");
  } else {
    for (const dep of dependents) out.push(`- ${dep} depends on your outputs`);
    out.push("");
  }

  out.push("## Your output obligations", "");
  if (worker.outputs.length === 0) {
    out.push("No declared outputs — completion is enough.", "");
  } else {
    for (const o of worker.outputs) {
      out.push(`- ${o.path} (${o.kind}${o.required ? ", REQUIRED" : ", optional"})`);
    }
    out.push("");
  }
  if (worker.outputs.some((o) => o.path.startsWith("output/"))) {
    out.push(`Save ALL output files to ${workerDir}/output/ — use absolute paths.`, "");
  }
  if (worker.outputs.some((o) => !o.path.startsWith("output/"))) {
    out.push("Write code changes directly at their repo paths.", "");
  }
  return out.join("\n");
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts test/prompts.test.ts
git commit -m "add: dag-aware worker prompt assembly"
```

---

### Task 8: Worker runtime (`src/runner.ts`)

**Files:**
- Create: `src/runner.ts`
- Test: `test/runner.test.ts` (unit, with fake session factory — no real LLM calls)

**Interfaces:**
- Consumes: `WORKER_TYPE_TOOLS`, `WorkerSpec` from `src/types.ts`; `buildWorkerPrompt` from `src/prompts.ts`
- Produces:
  - `WorkerEvent = { type: "turn" | "tokens" | "done" | "error"; nodeId: string; turns?: number; tokens?: number; message?: string }`
  - `SessionFactory = (opts: SessionOpts) => Promise<AgentSessionLike>` — injected for tests
  - `AgentSessionLike = { prompt(t: string): Promise<void>; abort(): Promise<void>; subscribe(l: (e: { type: string }) => void): () => void; dispose(): void }`
  - `runWorker(opts: RunWorkerOpts): Promise<RunWorkerResult>`
  - `RunWorkerOpts = { nodeId: string; worker: WorkerSpec; prompt: string; repoCwd: string; model?: string; onEvent: (e: WorkerEvent) => void; sessionFactory?: SessionFactory }`
  - `RunWorkerResult = { ok: boolean; turns: number; tokens: number; error?: string }`
  - `defaultSessionFactory: SessionFactory` — wraps `createAgentSession({ cwd: repoCwd, tools: WORKER_TYPE_TOOLS[worker.type], sessionManager: SessionManager.create(workerSessionDir) })`; resolves model via `ctx.modelRegistry` passed in opts if `worker.model` set (fuzzy match, else error)

Turn counting: count `turn_end` events. Token counting: sum `message_end` assistant `usage.totalTokens` (guard missing). Errors: catch prompt() rejection → `{ ok: false, error }`. Always `dispose()` in finally.

- [ ] **Step 1: Write the failing test**

```typescript
// test/runner.test.ts
import { describe, expect, it } from "vitest";
import { runWorker } from "../src/runner.js";
import type { WorkerSpec } from "../src/types.js";

const worker: WorkerSpec = { id: "w", type: "code-run", task: "t", depends_on: [], outputs: [] };

function fakeSession(behavior: "ok" | "throw") {
  const listeners: ((e: { type: string }) => void)[] = [];
  return {
    async prompt() {
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 100 } } });
      if (behavior === "throw") throw new Error("boom");
    },
    async abort() {},
    subscribe(l: (e: { type: string }) => void) { listeners.push(l); return () => {}; },
    dispose() {},
  };
}

describe("runWorker", () => {
  it("counts turns and tokens, reports done", async () => {
    const events: string[] = [];
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: (e) => events.push(e.type),
      sessionFactory: async () => fakeSession("ok"),
    });
    expect(r.ok).toBe(true);
    expect(r.turns).toBe(1);
    expect(r.tokens).toBe(100);
    expect(events).toContain("done");
  });
  it("returns ok:false on session error", async () => {
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: () => {},
      sessionFactory: async () => fakeSession("throw"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/runner.ts**

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkerSpec } from "./types.js";
import { WORKER_TYPE_TOOLS } from "./types.js";

export type WorkerEvent =
  | { type: "turn"; nodeId: string; turns: number }
  | { type: "tokens"; nodeId: string; tokens: number }
  | { type: "done"; nodeId: string }
  | { type: "error"; nodeId: string; message: string };

export interface AgentSessionLike {
  prompt(t: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(l: (e: { type: string; message?: unknown }) => void): () => void;
  dispose(): void;
}

export interface SessionOpts {
  cwd: string;
  sessionDir: string;
  tools: string[];
  model?: string;
}

export type SessionFactory = (opts: SessionOpts) => Promise<AgentSessionLike>;

export const defaultSessionFactory: SessionFactory = async (opts) => {
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    tools: opts.tools,
    sessionManager: SessionManager.create(opts.sessionDir),
  });
  return session as unknown as AgentSessionLike;
};

export interface RunWorkerOpts {
  nodeId: string;
  worker: WorkerSpec;
  prompt: string;
  repoCwd: string;
  sessionDir?: string;
  onEvent: (e: WorkerEvent) => void;
  sessionFactory?: SessionFactory;
}

export interface RunWorkerResult {
  ok: boolean;
  turns: number;
  tokens: number;
  error?: string;
}

export async function runWorker(opts: RunWorkerOpts): Promise<RunWorkerResult> {
  const factory = opts.sessionFactory ?? defaultSessionFactory;
  const session = await factory({
    cwd: opts.repoCwd,
    sessionDir: opts.sessionDir ?? opts.repoCwd,
    tools: WORKER_TYPE_TOOLS[opts.worker.type],
    model: opts.worker.model,
  });
  let turns = 0;
  let tokens = 0;
  const unsub = session.subscribe((e) => {
    if (e.type === "turn_end") {
      turns++;
      opts.onEvent({ type: "turn", nodeId: opts.nodeId, turns });
    }
    if (e.type === "message_end") {
      const msg = e.message as { role?: string; usage?: { totalTokens?: number } } | undefined;
      if (msg?.role === "assistant" && msg.usage?.totalTokens) {
        tokens += msg.usage.totalTokens;
        opts.onEvent({ type: "tokens", nodeId: opts.nodeId, tokens });
      }
    }
  });
  try {
    await session.prompt(opts.prompt);
    opts.onEvent({ type: "done", nodeId: opts.nodeId });
    return { ok: true, turns, tokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onEvent({ type: "error", nodeId: opts.nodeId, message });
    return { ok: false, turns, tokens, error: message };
  } finally {
    unsub();
    session.dispose();
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. If `SessionManager.create` signature mismatches the SDK, check `docs/sdk.md` and adjust (it may take `(cwd, sessionDir)` — adapt the call, keep the `SessionFactory` interface unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts test/runner.test.ts
git commit -m "add: in-process worker runtime with injectable session factory"
```

---

### Task 9: Scheduler (`src/scheduler.ts`)

**Files:**
- Create: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: everything prior — `FleetSpec`, `FleetState`, `topoLayers`, `initFleetState`, `patchNode`, `writeState`, `verifyOutputs`, `buildWorkerPrompt`, `runWorker` (as injectable)
- Produces:
  - `SpawnFn = (nodeId: string) => Promise<{ ok: boolean; turns: number; tokens: number; error?: string }>`
  - `runFleet(opts: RunFleetOpts): Promise<FleetState>`
  - `RunFleetOpts = { spec: FleetSpec; fleetRoot: string; repoCwd: string; spawn?: SpawnFn; onNodeChange?: (nodeId: string, s: NodeState) => void; killSwitch?: { killed: boolean } }`

Algorithm (default `spawn` = real worker runner wired in Task 11; tests inject fakes):
1. `state = initFleetState(spec)`; set `status: "running"`; writeState.
2. Loop until all nodes terminal:
   - `ready` = pending nodes whose deps are all `completed`
   - mark `blocked` any pending node with a dep in {failed, contract_failed, killed, blocked}; persist
   - if `killSwitch.killed`: mark all non-terminal `killed`, break
   - dispatch ready nodes up to `max_concurrent` running total: status `running`, started_at, persist, call `spawn(nodeId)`
   - on spawn resolve: persist turns/tokens; if `!ok` → `failed`; else run `verifyOutputs` for the worker → `completed` or `contract_failed` (store `contract_result`); persist; call `onNodeChange`
3. Final fleet status: any `failed|contract_failed` → `"failed"`; killSwitch → `"killed"`; else `"completed"`. writeState. Return state.

- [ ] **Step 1: Write the failing test**

```typescript
// test/scheduler.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFleet } from "../src/scheduler.js";
import type { FleetSpec } from "../src/types.js";

function spec(): FleetSpec {
  return {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 2, model: "k2p6" },
    workers: [
      { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
      { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
    ],
  };
}

async function root() {
  const r = await mkdtemp(join(tmpdir(), "fleet-sched-"));
  await mkdir(join(r, "workers", "a", "output"), { recursive: true });
  await mkdir(join(r, "workers", "b", "output"), { recursive: true });
  return r;
}

describe("runFleet", () => {
  it("runs deps in order, completes", async () => {
    const order: string[] = [];
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => { order.push(id); return { ok: true, turns: 1, tokens: 10 }; },
    });
    expect(order).toEqual(["a", "b"]);
    expect(s.status).toBe("completed");
    expect(s.nodes.a.status).toBe("completed");
    expect(s.cost_usd_estimate).toBeGreaterThanOrEqual(0);
  });
  it("blocks dependents of failed nodes", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => (id === "a" ? { ok: false, turns: 1, tokens: 5, error: "x" } : { ok: true, turns: 1, tokens: 5 }),
    });
    expect(s.nodes.a.status).toBe("failed");
    expect(s.nodes.b.status).toBe("blocked");
    expect(s.status).toBe("failed");
  });
  it("marks contract_failed when required output missing", async () => {
    const sp = spec();
    sp.workers[0].outputs = [{ path: "output/findings.md", kind: "markdown", required: true }];
    const s = await runFleet({
      spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 5 }), // writes nothing
    });
    expect(s.nodes.a.status).toBe("contract_failed");
    expect(s.nodes.a.contract_result?.ok).toBe(false);
    expect(s.nodes.b.status).toBe("blocked");
  });
  it("passes contract when worker wrote the file", async () => {
    const sp = spec();
    sp.workers[0].outputs = [{ path: "output/findings.md", kind: "markdown", required: true }];
    const fleetRoot = await root();
    const s = await runFleet({
      spec: sp, fleetRoot, repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "a") await writeFile(join(fleetRoot, "workers", "a", "output", "findings.md"), "# F\nbody");
        return { ok: true, turns: 1, tokens: 5 };
      },
    });
    expect(s.nodes.a.status).toBe("completed");
    expect(s.nodes.b.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/scheduler.ts**

```typescript
import { verifyOutputs } from "./contracts.js";
import { initFleetState, patchNode, writeState } from "./state.js";
import { TERMINAL_NODE_STATUSES } from "./types.js";
import type { FleetSpec, FleetState, NodeState } from "./types.js";

export type SpawnFn = (nodeId: string) => Promise<{ ok: boolean; turns: number; tokens: number; error?: string }>;

export interface RunFleetOpts {
  spec: FleetSpec;
  fleetRoot: string;
  repoCwd: string;
  spawn: SpawnFn;
  onNodeChange?: (nodeId: string, s: NodeState) => void;
  killSwitch?: { killed: boolean };
}

const FAILED: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed", "blocked"]);

export async function runFleet(opts: RunFleetOpts): Promise<FleetState> {
  const { spec, fleetRoot } = opts;
  let state = initFleetState(spec);
  state = { ...state, status: "running" };
  await writeState(fleetRoot, state);

  const patch = async (id: string, p: Partial<NodeState>) => {
    state = patchNode(fleetRoot, state, id, p);
    await writeState(fleetRoot, state);
    opts.onNodeChange?.(id, state.nodes[id]);
  };

  const running = new Set<Promise<void>>();

  while (true) {
    // block nodes whose deps failed
    for (const w of spec.workers) {
      const n = state.nodes[w.id];
      if (n.status !== "pending" && n.status !== "ready") continue;
      if (w.depends_on.some((d) => FAILED.has(state.nodes[d].status))) {
        await patch(w.id, { status: "blocked", ended_at: new Date().toISOString() });
      }
    }
    if (opts.killSwitch?.killed) {
      for (const w of spec.workers) {
        const n = state.nodes[w.id];
        if (!TERMINAL_NODE_STATUSES.has(n.status)) {
          await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
        }
      }
      break;
    }
    // dispatch ready
    const activeCount = running.size;
    let slots = spec.config.max_concurrent - activeCount;
    for (const w of spec.workers) {
      if (slots <= 0) break;
      const n = state.nodes[w.id];
      if (n.status !== "pending" && n.status !== "ready") continue;
      const depsDone = w.depends_on.every((d) => state.nodes[d].status === "completed");
      if (!depsDone) continue;
      slots--;
      await patch(w.id, { status: "running", started_at: new Date().toISOString() });
      const p = opts.spawn(w.id).then(async (res) => {
        if (!res.ok) {
          await patch(w.id, { status: "failed", ended_at: new Date().toISOString(), turns: res.turns, tokens: res.tokens });
          return;
        }
        const contract = await verifyOutputs({
          workerDir: `${fleetRoot}/workers/${w.id}`,
          repoCwd: opts.repoCwd,
          outputs: w.outputs,
        });
        await patch(w.id, {
          status: contract.ok ? "completed" : "contract_failed",
          ended_at: new Date().toISOString(),
          turns: res.turns,
          tokens: res.tokens,
          contract_result: contract,
          produced_outputs: contract.checks.filter((c) => c.ok).map((c) => c.path),
        });
      }).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size > 0) {
      await Promise.race(running);
    } else if (spec.workers.every((w) => TERMINAL_NODE_STATUSES.has(state.nodes[w.id].status))) {
      break;
    }
  }

  await Promise.allSettled([...running]);
  const anyFailed = spec.workers.some((w) =>
    ["failed", "contract_failed"].includes(state.nodes[w.id].status));
  const finalStatus = opts.killSwitch?.killed ? "killed" : anyFailed ? "failed" : "completed";
  state = { ...state, status: finalStatus };
  await writeState(fleetRoot, state);
  return state;
}
```

Note: default `spawn` is NOT defined here — Task 11 wires the real one (prompt build + runWorker). Tests always inject.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "add: ready-queue scheduler with blocked propagation and kill switch"
```

---

### Task 10: Report (`src/report.ts`)

**Files:**
- Create: `src/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `FleetSpec`, `FleetState`, `renderDag`
- Produces:
  - `writeReport(opts: { spec: FleetSpec; state: FleetState; fleetRoot: string; repoCwd: string }): Promise<string>` — writes `<fleetRoot>/report.md`, returns its content
  - `gitDiffStat(repoCwd: string, sinceIso: string): Promise<string>` — `git diff --stat` since fleet start; returns `"(not a git repo)"` or `"(no changes)"` gracefully. Implementation: `execFile("git", ["-C", repoCwd, "diff", "--stat", "HEAD"], ...)` wrapped in try/catch

Report sections: header (fleet_name, status, duration, total cost estimate, optional `experiment` tag if `spec as any).experiment` string present), ASCII DAG with statuses, per-node table (id, status, turns, tokens, cost, contract checks summary, produced outputs), git diff stat, artifact paths (`state.json`, `workers/*/session.jsonl`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/report.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiffStat, writeReport } from "../src/report.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [{ id: "a", type: "write", task: "do thing", depends_on: [], outputs: [] }],
};

describe("writeReport", () => {
  it("writes report.md with dag, node table, totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-"));
    let state = initFleetState(spec);
    state = { ...state, status: "completed" };
    state = patchNode(root, state, "a", { status: "completed", turns: 3, tokens: 1000, cost_usd_estimate: 0.02 });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("# Fleet report: t");
    expect(md).toContain("completed");
    expect(md).toContain("| a |");
    expect(md).toContain("$0.02");
  });
});

describe("gitDiffStat", () => {
  it("degrades gracefully outside a git repo", async () => {
    expect(await gitDiffStat("/nonexistent", new Date().toISOString())).toBe("(not a git repo)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/report.ts**

```typescript
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FleetSpec, FleetState } from "./types.js";
import { renderDag } from "./viz.js";

const execFileP = promisify(execFile);

export async function gitDiffStat(repoCwd: string, _sinceIso: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoCwd, "diff", "--stat", "HEAD"]);
    const out = stdout.trim();
    return out.length > 0 ? out : "(no changes)";
  } catch {
    return "(not a git repo)";
  }
}

export async function writeReport(opts: {
  spec: FleetSpec;
  state: FleetState;
  fleetRoot: string;
  repoCwd: string;
}): Promise<string> {
  const { spec, state, fleetRoot, repoCwd } = opts;
  const experiment = (spec as unknown as { experiment?: string }).experiment;
  const lines: string[] = [];
  lines.push(`# Fleet report: ${spec.fleet_name}`, "");
  lines.push(`- status: **${state.status}**`);
  lines.push(`- created: ${state.created_at}`);
  lines.push(`- total cost estimate: $${state.cost_usd_estimate.toFixed(2)}`);
  if (experiment) lines.push(`- experiment: ${experiment}`);
  lines.push("", "## DAG", "", "```", renderDag(spec, state), "```", "");
  lines.push("## Nodes", "", "| id | status | turns | tokens | cost | contract | outputs |",
    "|---|---|---|---|---|---|---|");
  for (const w of spec.workers) {
    const n = state.nodes[w.id];
    const contract = n.contract_result
      ? n.contract_result.ok ? "✓" : `✗ ${n.contract_result.checks.filter((c) => !c.ok).map((c) => c.path).join(", ")}`
      : "—";
    lines.push(`| ${w.id} | ${n.status} | ${n.turns} | ${n.tokens} | $${n.cost_usd_estimate.toFixed(2)} | ${contract} | ${n.produced_outputs.join(", ") || "—"} |`);
  }
  lines.push("", "## Code changes", "", "```", await gitDiffStat(repoCwd, state.created_at), "```", "");
  lines.push("## Artifacts", "", `- state: ${join(fleetRoot, "state.json")}`,
    `- sessions: ${join(fleetRoot, "workers", "<id>", "session.jsonl")}`, "");
  const md = lines.join("\n");
  await writeFile(join(fleetRoot, "report.md"), md, "utf-8");
  return md;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report.ts test/report.test.ts
git commit -m "add: machine-written fleet report with git diff stat"
```

---

### Task 11: Extension entry — tools + commands + UI (`src/index.ts`, `src/ui.ts`)

**Files:**
- Create: `src/ui.ts`
- Create: `src/index.ts`
- Test: `test/ui.test.ts` (widget line builder only — pure function)

**Interfaces:**
- Consumes: all prior modules
- Produces:
  - `buildWidgetLines(spec: FleetSpec, state: FleetState): string[]` (ui.ts — pure)
  - default extension export registering tools `fleet_plan`, `fleet_launch`, `fleet_status`, `fleet_kill`, `fleet_report` and commands `/fleet viz|status|kill`
  - `ActiveFleet = { spec: FleetSpec; fleetRoot: string; state: FleetState; killSwitch: { killed: boolean }; running: boolean }` — module-level singleton (one active fleet per session in v1)

`src/ui.ts`:

```typescript
import type { FleetSpec, FleetState, NodeStatus } from "./types.js";

const ICON: Record<NodeStatus, string> = {
  completed: "✓", failed: "✗", contract_failed: "✗",
  running: "⠹", blocked: "⊘", killed: "⊘", pending: "○", ready: "○",
};

export function buildWidgetLines(spec: FleetSpec, state: FleetState): string[] {
  const done = spec.workers.filter((w) => state.nodes[w.id].status === "completed").length;
  const lines = [`● fleet: ${spec.fleet_name}  (${done}/${spec.workers.length} done · $${state.cost_usd_estimate.toFixed(2)})`];
  spec.workers.forEach((w, i) => {
    const n = state.nodes[w.id];
    const branch = i === spec.workers.length - 1 ? "└─" : "├─";
    const detail = n.status === "running" ? ` · ${n.turns} turns · ${(n.tokens / 1000).toFixed(1)}k tok` : "";
    const note = n.status_note ? ` · ${n.status_note}` : "";
    lines.push(`${branch} ${ICON[n.status]} ${w.id}${detail}${note}`);
  });
  return lines;
}
```

`src/index.ts` behavior:

- `fleet_plan` tool: params `{ fleet: <object> }` → `validateFleetSpec`; on error return errors text; on ok: create fleet root `.fleet/<fleet_name>-<yyyymmdd-hhmmss>/` (mkdir recursive incl. `workers/<id>/output/` per node), write `fleet.json` + `state.json` (init), ensure `.fleet/.gitignore` contains `*`, store `ActiveFleet` with `running: false`. Return ASCII `renderDag(spec)` + fleet root path + "call fleet_launch to start".
- `fleet_launch` tool: no params. Requires active fleet not running. In TUI (`ctx.hasUI`): `ctx.ui.confirm("Launch fleet?", renderDag(spec))` — abort if declined. Then: write per-worker `prompt.md` via `buildWorkerPrompt`, define `spawn` = `(nodeId) => runWorker({ nodeId, worker, prompt, repoCwd: ctx.cwd, sessionDir: <fleetRoot>/workers/<id>, onEvent: e => update widget via ctx.ui.setWidget("fleet", buildWidgetLines(spec, state)) })`, call `runFleet({...})` WITHOUT awaiting (fire and forget; `running: true`); subscribe completion → `writeReport` + `ctx.ui.notify`. Return "fleet launched".
- `fleet_status` tool: return `renderDag(spec, state)` + widget lines as text (read fresh `state.json` if `!running`).
- `fleet_kill` tool: params `{ target: string }` — `"all"` sets `killSwitch.killed = true`. Single-node kill v1: sets killSwitch only if target is `"all"`; for a node id, return "single-node kill not supported in v1 — use all" (scheduler kill is fleet-wide; per-node abort tracked in spec as v1 limitation — document in tool description).
- `fleet_report` tool: regenerates report from current state, returns markdown.
- Commands: `/fleet viz` → `ctx.ui.notify` + setWidget with `renderDag`; `/fleet status` → same as tool; `/fleet kill all` → same as tool. Guard: no active fleet → notify "no fleet planned yet".
- `session_start`: `ctx.ui.setStatus("fleet", "")` noop init; clear singleton.

- [ ] **Step 1: Write the failing widget test**

```typescript
// test/ui.test.ts
import { describe, expect, it } from "vitest";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { buildWidgetLines } from "../src/ui.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

describe("buildWidgetLines", () => {
  it("renders header and per-node lines", () => {
    let s = initFleetState(spec);
    s = patchNode("/x", s, "a", { status: "running", turns: 3, tokens: 1200 });
    const lines = buildWidgetLines(spec, s);
    expect(lines[0]).toContain("fleet: t");
    expect(lines[0]).toContain("0/2 done");
    expect(lines[1]).toContain("⠹ a");
    expect(lines[1]).toContain("3 turns");
    expect(lines[2]).toContain("○ b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Implement src/ui.ts (code above), then src/index.ts**

Skeleton for index.ts (fill per behavior list; keep functions small):

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateFleetSpec } from "./dag.js";
import { buildWorkerPrompt } from "./prompts.js";
import { writeReport } from "./report.js";
import { runWorker } from "./runner.js";
import { runFleet } from "./scheduler.js";
import { initFleetState, readState, writeState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";
import { buildWidgetLines } from "./ui.js";
import { dagNeedsFileFallback, renderDag } from "./viz.js";

interface ActiveFleet {
  spec: FleetSpec;
  fleetRoot: string;
  state: FleetState;
  killSwitch: { killed: boolean };
  running: boolean;
}

let active: ActiveFleet | undefined;

function fleetRootFor(cwd: string, name: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return join(cwd, ".fleet", `${name}-${ts}`);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => { active = undefined; });

  pi.registerTool({
    name: "fleet_plan",
    label: "Fleet Plan",
    description:
      "Validate a fleet DAG definition, create its fleet root, and return an ASCII preview. Does NOT launch. Call fleet_launch after the user confirms the preview.",
    parameters: Type.Object({
      fleet: Type.Object({}, { additionalProperties: true, description: "Fleet definition (fleet.json shape)" }),
    }),
    async execute(_id, params) {
      const v = validateFleetSpec(params.fleet);
      if (!v.ok) return { content: [{ type: "text", text: `Invalid fleet:\n${v.errors.join("\n")}` }], details: {} };
      // ... create root, workers dirs, fleet.json, state.json, .fleet/.gitignore, set active
      // ... return renderDag(v.spec) + root path
    },
  });

  // fleet_launch, fleet_status, fleet_kill, fleet_report per behavior list
  // /fleet viz|status|kill commands per behavior list
}
```

Full index.ts is written by the implementer following the behavior list above; each tool handler returns `{ content: [{ type: "text", text }], details: {} }`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Fix any SDK type mismatches against `docs/extensions.md` / `docs/sdk.md`.

- [ ] **Step 5: Manual smoke in TUI**

Run: `pi -e ./src/index.ts`
In session: ask agent to plan a 2-worker fleet → expect `fleet_plan` preview → `/fleet viz` → `fleet_launch` confirm → widget live updates.
Expected: preview renders, widget updates, state.json appears under `.fleet/`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/ui.ts test/ui.test.ts
git commit -m "add: extension entry with fleet tools, commands, live widget"
```

---

### Task 12: End-to-end smoke fleet

**Files:**
- Create: `examples/two-worker-fleet.json`
- Modify: `README.md` (usage section)

**Interfaces:**
- Consumes: everything

- [ ] **Step 1: Write examples/two-worker-fleet.json**

```json
{
  "fleet_name": "smoke",
  "type": "dag",
  "config": { "max_concurrent": 2, "model": "k2p6" },
  "workers": [
    {
      "id": "research",
      "type": "research",
      "task": "Write 3 bullet points about what makes a good CLI UX. Keep it under 100 words.",
      "depends_on": [],
      "outputs": [{ "path": "output/findings.md", "kind": "markdown", "required": true }]
    },
    {
      "id": "summarize",
      "type": "write",
      "task": "Read the upstream findings and write a one-sentence summary.",
      "depends_on": ["research"],
      "outputs": [{ "path": "output/summary.md", "kind": "markdown", "required": true }]
    }
  ]
}
```

- [ ] **Step 2: Run smoke fleet**

Run: `pi -e ./src/index.ts -p "Plan and launch the fleet defined in examples/two-worker-fleet.json, then report status when done."`
Expected: `.fleet/smoke-*/report.md` exists; both nodes `completed`; report contains produced outputs. If headless `-p` skips the confirm (hasUI=false), launch proceeds — note this in README.

- [ ] **Step 3: Write README usage section** — install (`pi -e` dev mode, or `pi install` later), tool list, `/fleet` commands, link to spec + ontology.

- [ ] **Step 4: Commit**

```bash
git add examples/two-worker-fleet.json README.md
git commit -m "add: smoke fleet example and usage docs"
```

---

## Self-review notes

- Spec coverage: DAG core §5→T3, contracts §6→T4 (+prompts T7), state §7→T5, scheduling §8→T9, tools/commands §9→T11, UI §10→T6+T11, report §11→T10, cost §12→runner tokens + state cost fields (model-price-based estimate deferred: tokens tracked, USD via tokens — acceptable v1, warn threshold checked in widget update path in T11), errors §13→T9+T11, testing §14→throughout +T12.
- Known v1 limitations (documented in tool descriptions): single-node kill deferred (fleet-wide kill only), USD cost is token-based estimate without per-model pricing lookup, worker-mode `fleet_dag_read`/`fleet_node_update` tools deferred to v2 (prompt-level DAG awareness ships instead — spec §6 write-scoping noted as v2).
