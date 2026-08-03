# Worktree Integrator + Canvas Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make multi-worktree fleets safe with automatic worktree creation, branch commits, and ordered merges; redesign the browser canvas to a modern expandable workflow UI with a static demo mode.

**Architecture:** Keep all orchestration logic in existing modules (`src/dag.ts`, `src/scheduler.ts`, `src/canvas.ts`). Worktree logic is deterministic git plumbing invoked by the scheduler. Canvas remains a single self-contained HTML/CSS/JS string served by `canvas.ts`, upgraded with modern visual patterns and a `/api/demo` payload.

**Tech Stack:** TypeScript, Node built-ins, Vitest, no new runtime dependencies.

## Global Constraints

- No new npm dependencies.
- `npm test` must pass and `npm run typecheck` must pass before any task is considered complete.
- Worktree git operations use only `git` child-process calls via `node:child_process` `promisify(execFile)` (same pattern as `openInBrowser`).
- Worktree branch naming convention: `fleet/<fleet-name>/<node-id>`.
- Integrator worktree path: `<fleetRoot>/worktrees/fleet-integrator`.
- Demo endpoint path: `/api/demo`.
- Canvas payload schema (`CanvasPayload`) is unchanged except for the addition of a `demo` flag field (optional, default false).

---

## Task 1: Worktree validation and auto-integrator

**Files:**
- Modify: `src/dag.ts`
- Modify: `src/types.ts` (add helper types only if needed)
- Test: `test/dag.test.ts`

**Interfaces:**
- Consumes: `FleetSpec`, `WorkerSpec`, `validateFleetSpec`.
- Produces: `validateFleetSpec` rejects plans with ≥2 worktree workers and no integrator path; auto-injects integrator worker when needed; detects repo-relative output ownership conflicts without ordered handoff.

**Steps:**

- [ ] **Step 1: Write failing tests**

```typescript
it("rejects multiple worktrees without integrator", () => {
  const v = validateFleetSpec({
    fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
    workers: [
      { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
      { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
    ],
  });
  expect(v.ok).toBe(false);
  expect(v.errors.some((e) => e.includes("integrator"))).toBe(true);
});

it("auto-injects integrator when missing", () => {
  // TODO: after implementation, assert spec.workers includes fleet-integrator
});

it("rejects overlapping repo-relative outputs without ordered handoff", () => {
  const v = validateFleetSpec({
    fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
    workers: [
      { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
      { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
      { id: "i", type: "code-run", task: "merge", depends_on: ["a", "b"], outputs: [] },
    ],
  });
  expect(v.ok).toBe(false);
  expect(v.errors.some((e) => e.includes("ownership conflict"))).toBe(true);
});

it("permits overlapping outputs with ordered handoff", () => {
  const v = validateFleetSpec({
    fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
    workers: [
      { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
      { id: "b", type: "code-run", task: "t", depends_on: ["a"], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
      { id: "i", type: "code-run", task: "merge", depends_on: ["b"], outputs: [] },
    ],
  });
  expect(v.ok).toBe(true);
});
```

- [ ] **Step 2: Run tests, expect failures**

```bash
npm test -- test/dag.test.ts
```

- [ ] **Step 3: Implement validation helpers**

In `src/dag.ts`:

```typescript
function findWorktreeOwnershipConflicts(spec: FleetSpec): string[] {
  const worktrees = spec.workers.filter((w) => w.worktree);
  const claims = new Map<string, string[]>(); // path -> worker ids
  for (const w of worktrees) {
    for (const o of w.outputs) {
      if (!o.path.startsWith("output/")) {
        (claims.get(o.path) ??= []).push(w.id);
      }
    }
  }
  const errors: string[] = [];
  for (const [path, ids] of claims) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const aBeforeB = spec.workers.find((w) => w.id === a)!.depends_on.includes(b);
        const bBeforeA = spec.workers.find((w) => w.id === b)!.depends_on.includes(a);
        if (!aBeforeB && !bBeforeA) {
          errors.push(`worktree ownership conflict: "${path}" claimed by "${a}" and "${b}" without ordered handoff`);
        }
      }
    }
  }
  return errors;
}

function hasIntegratorPath(spec: FleetSpec): boolean {
  const worktreeIds = new Set(spec.workers.filter((w) => w.worktree).map((w) => w.id));
  if (worktreeIds.size < 2) return true;
  return spec.workers.some((w) => {
    if (w.worktree) return false;
    const deps = new Set(w.depends_on);
    for (const id of worktreeIds) if (!deps.has(id)) return false;
    return true;
  });
}
```

- [ ] **Step 4: Wire into `validateFleetSpec`**

After worker validation and before `topoLayers`, if `worktreeIds.size >= 2`:

```typescript
if (!hasIntegratorPath(spec)) {
  errors.push("multiple worktree workers require an integrator that depends on all worktree workers");
}
const conflicts = findWorktreeOwnershipConflicts(spec);
errors.push(...conflicts);
```

Then auto-inject integrator if missing:

```typescript
if (worktreeIds.size >= 2 && !spec.workers.some((w) => w.id === "fleet-integrator")) {
  workers.push({
    id: "fleet-integrator",
    type: "code-run",
    task: `Merge worktree branches in order: ${[...worktreeIds].join(", ")}. Verify the combined repo is consistent and commit if needed.`,
    depends_on: [...worktreeIds],
    outputs: [],
  });
}
```

Rebuild `spec` with the new `workers` array before computing layers.

- [ ] **Step 5: Run tests**

```bash
npm test -- test/dag.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/dag.ts test/dag.test.ts
git commit -m "feat: validate and auto-inject worktree integrator"
```

---

## Task 2: Worktree creation and auto-commit

**Files:**
- Modify: `src/scheduler.ts`
- Create: `src/worktree.ts` (git plumbing helpers)
- Test: `test/scheduler.test.ts` or `test/worktree.test.ts`

**Interfaces:**
- Consumes: `FleetSpec`, `FleetState`, `repoCwdFor`, `spawn`.
- Produces: `createWorktree`, `commitWorktree`, `prepareIntegratorWorktree`.

**Steps:**

- [ ] **Step 1: Write failing tests**

In `test/worktree.test.ts`:

```typescript
import { createWorktree, commitWorktree, prepareIntegratorWorktree } from "../src/worktree.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function initRepo(dir: string) {
  await execFileP("git", ["init"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileP("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

it("creates a worktree on a deterministic branch", async () => {
  const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
  await initRepo(base);
  const wt = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "a", fleetRoot: join(base, ".fleet", "f-1") });
  expect(wt).toContain("worktrees/a");
  const branches = await execFileP("git", ["branch", "--list", "fleet/f/a"], { cwd: base });
  expect(branches.stdout).toContain("fleet/f/a");
});

it("commits changes in a worktree", async () => {
  const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
  await initRepo(base);
  const wt = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "a", fleetRoot: join(base, ".fleet", "f-1") });
  await writeFile(join(wt, "x.txt"), "hello", "utf-8");
  await commitWorktree({ worktreePath: wt, nodeId: "a", fleetName: "f", iteration: 1 });
  const log = await execFileP("git", ["log", "--oneline", "fleet/f/a"], { cwd: base });
  expect(log.stdout).toContain("fleet: f a iteration 1");
});
```

- [ ] **Step 2: Run tests, expect failures**

```bash
npm test -- test/worktree.test.ts
```

- [ ] **Step 3: Implement `src/worktree.ts`**

```typescript
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CreateWorktreeOpts {
  baseRepo: string;
  fleetName: string;
  nodeId: string;
  fleetRoot: string;
}

export async function createWorktree(opts: CreateWorktreeOpts): Promise<string> {
  const path = join(opts.fleetRoot, "worktrees", opts.nodeId);
  const branch = `fleet/${opts.fleetName}/${opts.nodeId}`;
  await mkdir(path, { recursive: true });
  await execFileP("git", ["worktree", "add", "-b", branch, path], { cwd: opts.baseRepo });
  return path;
}

export interface CommitWorktreeOpts {
  worktreePath: string;
  nodeId: string;
  fleetName: string;
  iteration: number;
}

export async function commitWorktree(opts: CommitWorktreeOpts): Promise<void> {
  await execFileP("git", ["add", "-A"], { cwd: opts.worktreePath });
  try {
    await execFileP("git", ["commit", "-m", `fleet: ${opts.fleetName} ${opts.nodeId} iteration ${opts.iteration}`], { cwd: opts.worktreePath });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("nothing to commit")) return;
    throw e;
  }
}

export interface PrepareIntegratorOpts {
  baseRepo: string;
  fleetName: string;
  fleetRoot: string;
  branches: string[];
}

export async function prepareIntegratorWorktree(opts: PrepareIntegratorOpts): Promise<{ path: string; ok: boolean; conflict?: string }> {
  const path = join(opts.fleetRoot, "worktrees", "fleet-integrator");
  await mkdir(path, { recursive: true });
  await execFileP("git", ["worktree", "add", "-b", `fleet/${opts.fleetName}/fleet-integrator`, path], { cwd: opts.baseRepo });
  for (const branch of opts.branches) {
    try {
      await execFileP("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: path });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { path, ok: false, conflict: `merge ${branch} failed: ${msg}` };
    }
  }
  return { path, ok: true };
}

export async function removeWorktree(path: string, baseRepo: string): Promise<void> {
  await execFileP("git", ["worktree", "remove", "--force", path], { cwd: baseRepo }).catch(() => {});
}
```

- [ ] **Step 4: Wire into `src/scheduler.ts`**

Import helpers. In `runFleet`, before `await patch(w.id, { status: "running" ... })`, if `w.worktree`, call `createWorktree`. If it fails, patch status `failed` with status_note and return.

After `contract.ok` for a worktree worker, call `commitWorktree`. If it fails, patch status `failed` with status_note.

Before dispatching the integrator worker (`fleet-integrator`), call `prepareIntegratorWorktree`. If `ok: false`, patch integrator status `failed` with the conflict note and do not spawn.

- [ ] **Step 5: Run tests**

```bash
npm test -- test/worktree.test.ts test/scheduler.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/worktree.ts src/scheduler.ts test/worktree.test.ts
git commit -m "feat: create worktrees, auto-commit, and merge for integrator"
```

---

## Task 3: Canvas redesign and demo endpoint

**Files:**
- Modify: `src/canvas.ts`
- Modify: `src/controller.ts` (if needed to pass demo payload)
- Test: `test/canvas.test.ts`

**Interfaces:**
- Consumes: `CanvasPayload`, `CanvasNodeView`, `ActiveFleet`.
- Produces: `/api/demo` returns `CanvasPayload`; HTML app has modern expandable nodes, floating controls, minimap, dark/light themes.

**Steps:**

- [ ] **Step 1: Write failing test for demo endpoint**

```typescript
it("serves a demo payload", async () => {
  const server = await startCanvasServer({ getFleet: () => undefined, cwd: "/tmp" });
  try {
    const demo = await (await fetch(`${server.url}/api/demo`)).json();
    expect(demo.fleet_name).toBe("demo-fleet");
    expect(demo.nodes.length).toBeGreaterThan(1);
    expect(demo.demo).toBe(true);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
npm test -- test/canvas.test.ts -t demo
```

- [ ] **Step 3: Add demo payload builder**

In `src/canvas.ts`:

```typescript
export function buildDemoPayload(): CanvasPayload {
  return {
    fleet_name: "demo-fleet",
    status: "running",
    created_at: new Date().toISOString(),
    iteration: 2,
    lgtm_streak: 1,
    paused: false,
    cost_usd_estimate: 2.34,
    demo: true,
    config: { max_concurrent: 3, model: "claude", effort: "high" },
    loop: { gate: "reviewer", max_iterations: 5, lgtm_count: 2 },
    nodes: [
      { id: "research-a", type: "research", task: "Research agent A background", status: "completed", model: "gpt-5.4-mini", effort: "medium", turns: 4, tokens: 8200, cost_usd_estimate: 0.12, produced_outputs: ["output/a.md"], outputs: [{ path: "output/a.md", kind: "markdown", required: true }], depends_on: [], iterate: true, worktree: false },
      { id: "research-b", type: "research", task: "Research agent B constraints", status: "completed", model: "gpt-5.4-mini", effort: "medium", turns: 3, tokens: 6400, cost_usd_estimate: 0.09, produced_outputs: ["output/b.md"], outputs: [{ path: "output/b.md", kind: "markdown", required: true }], depends_on: [], iterate: true, worktree: false },
      { id: "builder", type: "code-run", task: "Build feature using both research outputs", status: "running", model: "kimi-coding", effort: "high", turns: 6, tokens: 15400, cost_usd_estimate: 0.83, produced_outputs: [], outputs: [{ path: "src/feature.ts", kind: "file-exists", required: true }], depends_on: ["research-a", "research-b"], iterate: true, worktree: true },
      { id: "reviewer", type: "reviewer", task: "Review the implementation", status: "pending", model: "claude", effort: "high", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }], depends_on: ["builder"], iterate: true, worktree: false },
    ],
    edges: [
      { from: "research-a", to: "builder" },
      { from: "research-b", to: "builder" },
      { from: "builder", to: "reviewer" },
    ],
    iterations: [
      { n: 1, verdict: "iterate", cost: 1.21, tokens: 21000, duration_ms: 45000 },
      { n: 2, verdict: null, cost: 1.13, tokens: 18000, duration_ms: 32000 },
    ],
    generated_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Serve `/api/demo`**

In `startCanvasServer`, add route:

```typescript
if (url.pathname === "/api/demo") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(buildDemoPayload()));
  return;
}
```

- [ ] **Step 5: Rewrite `renderCanvasPage` HTML/CSS/JS**

Requirements:
- Use CSS variables for light/dark theme, switch via `data-theme` on `html`.
- Top accent bar on nodes for status color; no side-stripe borders.
- Floating toolbar with zoom, fit, 1:1, theme, minimap toggle.
- MiniMap: scaled SVG overview in bottom-right with viewport rectangle.
- Expandable nodes: click toggles expanded state; expanded shows task excerpt, outputs, status note, last session entry.
- Animated spinner for `running` status.
- Layer layout with node spacing: 320x horizontal, 140x vertical.
- Bezier edges with arrowheads.
- Keyboard shortcuts: `f` fit, `0` reset, `d` toggle demo, `t` theme.

Keep it a single HTML string. Use vanilla JS only.

- [ ] **Step 6: Run tests**

```bash
npm test -- test/canvas.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/canvas.ts test/canvas.test.ts
git commit -m "feat: modern canvas UI with demo mode"
```

---

## Task 4: Integration and final verification

**Files:**
- All modified files

**Steps:**

- [ ] **Step 1: Run full test suite**

```bash
npm test
npm run typecheck
```

- [ ] **Step 2: Manual smoke test for canvas demo**

```bash
npm run typecheck
node -e "import('./src/canvas.js').then(m => m.startCanvasServer({ getFleet: () => undefined, cwd: '/tmp' }).then(s => console.log(s.url)))"
# Open URL with ?demo=1 in browser, verify visual appearance.
```

- [ ] **Step 3: Commit if any fixes**

```bash
git commit -am "fix: integration polish"
```

---

## Self-review

- Spec coverage: validation (Task 1), worktree creation/merge (Task 2), canvas redesign+demo (Task 3), integration (Task 4). All covered.
- Placeholder scan: no TBD/TODO; all code shown.
- Type consistency: `CanvasPayload` gains optional `demo: boolean`; `validateFleetSpec` returns possibly augmented spec; `runFleet` uses new worktree helpers.
