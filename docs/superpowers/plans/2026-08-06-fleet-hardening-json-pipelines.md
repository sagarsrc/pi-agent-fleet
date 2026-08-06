# Fleet Hardening + JSON Number Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden pi-agent-fleet for real usage by fixing model resolution/UX, fleet recovery/status handoff, JSON output contracts, and worktree/persistence safety, and ship a dead-simple JSON numbers pipeline example.

**Architecture:** Keep changes modular: model registry helpers stay in `src/model-resolution.ts`; recovery helpers move out of canvas into a small recovery module; contract schema checks stay in `src/contracts.ts`; DAG ownership validation stays in `src/dag.ts`; worktree branch lifecycle stays in `src/worktree.ts`. No new runtime dependencies. Tests remain zero-API vitest with fakes.

**Tech Stack:** TypeScript ESM, vitest, typebox, pi ExtensionAPI.

## Global Constraints

- Work only in branch/worktree `fleet-hardening`; do not touch the dirty main checkout files (`src/canvas-client.tsx`, `src/canvas.ts`, `test/canvas.test.ts` in main).
- No new runtime dependencies. Dev-only changes must not alter `package.json` dependencies.
- Public tool schemas must remain backward compatible unless this plan explicitly adds an optional field.
- Every new behavior must have a failing test first, then implementation, then passing test.
- Keep JSON pipeline example dead simple: workers write JSON files under `output/`; downstream workers consume those exact paths.
- Atomic persistence for `state.json` and `fleet.json` is required: write tmp file then `rename`.
- Model references shown to users must be canonical `provider/id`.

---

### Task 1: Strict model resolution with actionable registry errors

**Files:**
- Modify: `src/model-resolution.ts`
- Modify: `src/tools.ts`
- Modify: `src/command.ts`
- Test: `test/model-resolution.test.ts`
- Test: `test/tools-models.test.ts` (create)

**Interfaces:**
- Consumes: existing `ModelRegistryLike`, `resolveModelReference`, `validateFleetModels`.
- Produces:
  - `canonicalModelRef(model: Model<Api>): string`
  - `listModelRefs(registry: ModelRegistryLike, limit?: number): string[]`
  - `suggestModelRefs(registry: ModelRegistryLike, ref: string, limit?: number): string[]`
  - `formatModelError(registry: ModelRegistryLike, label: string, ref: string, error: string): string`
  - `resolveModelReference` no longer uses substring matching tier.

- [ ] **Step 1: Write failing tests**

Add to `test/model-resolution.test.ts`:

```ts
it("rejects substring-only model matches", () => {
  const registry = fakeRegistry([
    fakeModel("kimi-coding", "kimi-for-coding"),
    fakeModel("kimi-coding", "k3"),
  ]);
  const r = resolveModelReference(registry, "for-coding");
  expect(r.ok).toBe(false);
});

it("formats not-found errors with available and suggested refs", () => {
  const registry = fakeRegistry([
    fakeModel("kimi-coding", "kimi-for-coding"),
    fakeModel("kimi-coding", "k3"),
    fakeModel("openai", "gpt-5.4-mini"),
  ]);
  const r = validateFleetModels(specWithModel("kimi-for-coding/k2.7"), registry);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.join("\n")).toContain("available models:");
    expect(r.errors.join("\n")).toContain("kimi-coding/kimi-for-coding");
  }
});
```

Create `test/tools-models.test.ts` with a fake `ctx.modelRegistry` and assert `fleet_plan` invalid-model output contains `available models:` and canonical refs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/model-resolution.test.ts test/tools-models.test.ts`
Expected: FAIL (`formatModelError`/`listModelRefs` missing; substring tier still present).

- [ ] **Step 3: Implement model helpers**

In `src/model-resolution.ts` add:

```ts
export function canonicalModelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function listModelRefs(registry: ModelRegistryLike, limit = 40): string[] {
  const models = registry.getAvailable().length > 0 ? registry.getAvailable() : registry.getAll();
  return [...new Map(models.map((m) => [canonicalModelRef(m), m])).keys()].slice(0, limit);
}

export function suggestModelRefs(registry: ModelRegistryLike, ref: string, limit = 8): string[] {
  const needle = ref.toLowerCase();
  return listModelRefs(registry, 200)
    .filter((r) => r.toLowerCase().includes(needle) || needle.split(/[/-]/).some((p) => p.length > 2 && r.toLowerCase().includes(p)))
    .slice(0, limit);
}

export function formatModelError(registry: ModelRegistryLike, label: string, ref: string, error: string): string {
  const suggestions = suggestModelRefs(registry, ref);
  const available = listModelRefs(registry);
  return [
    `${label}: ${error}`,
    suggestions.length > 0 ? `suggestions: ${suggestions.join(", ")}` : undefined,
    `available models: ${available.join(", ")}`,
  ].filter(Boolean).join("\n");
}
```

Remove the final substring tier from `resolveModelReference` (`a.includes(needle)`). Keep exact canonical, exact alias, id exact, alias exact, prefix tiers. Update `validateFleetModels` to push `formatModelError(...)`.

- [ ] **Step 4: Surface registry through tools**

In `src/tools.ts`:
- Add tool `fleet_models` that returns `available models:\n${listModelRefs(ctx.modelRegistry).join("\n")}`.
- Update invalid model returns in `fleet_plan`/`fleet_launch` to use the new errors (already formatted by `validateFleetModels`).
- Add to `fleet_plan` description: "Call fleet_models first if you do not know exact provider/model IDs."

In `src/command.ts` add `/fleet models` branch that notifies the same list.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/model-resolution.test.ts test/tools-models.test.ts test/model-resolution.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model-resolution.ts src/tools.ts src/command.ts test/model-resolution.test.ts test/tools-models.test.ts
git commit -m "feat(fleet): strict model resolution with registry suggestions"
```

---

### Task 2: Validate preference model values against live registry

**Files:**
- Modify: `src/preferences.ts`
- Modify: `src/command.ts`
- Test: `test/preferences.test.ts`
- Test: `test/command-preferences.test.ts` (create)

**Interfaces:**
- Consumes: `setPreference`, `validatePreferenceValue`, `resolveModelReference`.
- Produces: `setPreference(prefs, key, value, registry?)` canonicalizes model when registry provided; rejects invalid model with suggestions.

- [ ] **Step 1: Write failing tests**

Add to `test/preferences.test.ts`:

```ts
it("rejects unknown model preference with registry suggestions", () => {
  const r = setPreference({}, "model", "kimi-for-coding/k2.7", fakeRegistry([fakeModel("kimi-coding", "kimi-for-coding")]));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("kimi-coding/kimi-for-coding");
});

it("stores canonical model preference", () => {
  const r = setPreference({}, "model", "kimi-for-coding", fakeRegistry([fakeModel("kimi-coding", "kimi-for-coding")]));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.prefs.model).toBe("kimi-coding/kimi-for-coding");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/preferences.test.ts`
Expected: FAIL (`setPreference` accepts only 3 args today).

- [ ] **Step 3: Implement registry-aware preferences**

Change `validatePreferenceValue` and `setPreference` to accept optional `registry?: ModelRegistryLike`. For `key === "model"` and registry present, call `resolveModelReference`; on failure return `{ ok: false, error: formatModelError(registry, "preference model", value, r.error) }`; on success store canonical ref.

Update `src/command.ts` `/fleet configure set` and wizard paths to pass `ctx.modelRegistry` into `setPreference`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/preferences.test.ts test/command-preferences.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preferences.ts src/command.ts test/preferences.test.ts test/command-preferences.test.ts
git commit -m "feat(fleet): validate preference models against registry"
```

---

### Task 3: Recover fleets from disk and add next-action status/report handoff

**Files:**
- Create: `src/fleet-recovery.ts`
- Modify: `src/canvas.ts`
- Modify: `src/controller.ts`
- Modify: `src/tools.ts`
- Modify: `src/command.ts`
- Modify: `src/report.ts`
- Test: `test/fleet-recovery.test.ts` (create)
- Test: `test/report-next-actions.test.ts` (create)

**Interfaces:**
- Consumes: existing canvas `readDiskFleet`, `listFleetRoots` logic; `writeReport`; `statusText`.
- Produces:
  - `fleet-recovery.ts`: `readDiskFleet`, `listFleetRoots`, `recoverLatestFleet(cwd): Promise<ActiveFleet | undefined>`.
  - `statusText(fleet)` appends report path and next action line.
  - `writeReport` includes `## Next steps` and `## JSON outputs` sections.

- [ ] **Step 1: Write failing tests**

Create `test/fleet-recovery.test.ts`:

```ts
it("recovers latest fleet root from disk when activeFleet is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
  const root = join(dir, ".fleet", "demo-20260101000000");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "fleet.json"), JSON.stringify(minimalSpec), "utf-8");
  await writeFile(join(root, "state.json"), JSON.stringify(initFleetState(minimalSpec)), "utf-8");
  const recovered = await recoverLatestFleet(dir);
  expect(recovered?.fleetRoot).toBe(root);
});
```

Create `test/report-next-actions.test.ts` asserting report contains `## Next steps`, `fleet_relaunch <id>` for failed nodes, and `## JSON outputs` with inlined small JSON content.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/fleet-recovery.test.ts test/report-next-actions.test.ts`
Expected: FAIL (module/functions/sections missing).

- [ ] **Step 3: Move disk recovery into `src/fleet-recovery.ts`**

Create module with the same implementations currently in `src/canvas.ts` for `readDiskFleet` and `listFleetRoots`, plus:

```ts
export async function recoverLatestFleet(cwd: string): Promise<ActiveFleet | undefined> {
  const roots = await listFleetRoots(cwd);
  const latest = roots.find((r) => r.status !== "unknown") ?? roots[0];
  if (!latest) return undefined;
  return readDiskFleet(latest.root);
}
```

Update `src/canvas.ts` to import and re-export `readDiskFleet`/`listFleetRoots` from `./fleet-recovery.js` (keep existing test imports working). Delete the old local implementations.

- [ ] **Step 4: Wire recovery + next actions**

In `src/tools.ts` and `src/command.ts`, before returning `no fleet planned yet`, call `recoverLatestFleet(ctx.cwd)`; if found, set `activeFleet.current = recovered` and continue with status/report/kill read-only behavior.

In `src/controller.ts` `statusText`, append:

```ts
const reportPath = join(fleet.fleetRoot, "report.md");
const failed = Object.entries(state.nodes).find(([, n]) => n.status === "failed" || n.status === "contract_failed");
const next = state.status === "planned" ? "next: fleet_launch"
  : state.status === "running" ? "next: fleet_status, fleet_canvas, or fleet_kill <id>|all"
  : failed ? `next: fleet_relaunch ${failed[0]}`
  : state.status === "completed" ? `next: read report ${reportPath}`
  : `next: inspect ${join(fleet.fleetRoot, "state.json")}`;
return `${renderDag(fleet.spec, state)}\n\nreport: ${reportPath}\n${next}`;
```

In `src/report.ts` add `## Next steps` with the same rules and `## JSON outputs`: for each produced output ending in `.json` under a worker `output/`, read up to 4096 bytes and inline in fenced `json` blocks.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/fleet-recovery.test.ts test/report-next-actions.test.ts test/canvas.test.ts test/controller.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fleet-recovery.ts src/canvas.ts src/controller.ts src/tools.ts src/command.ts src/report.ts test/fleet-recovery.test.ts test/report-next-actions.test.ts
git commit -m "feat(fleet): recover disk fleets and add next-action handoff"
```

---

### Task 4: JSON output schemas for numeric pipelines

**Files:**
- Modify: `src/types.ts`
- Modify: `src/tools.ts`
- Modify: `src/dag.ts`
- Modify: `src/contracts.ts`
- Modify: `src/prompts.ts`
- Create: `examples/json-number-pipeline.json`
- Test: `test/contracts-json-schema.test.ts` (create)
- Test: `test/dag-json-schema.test.ts` (create)
- Test: `test/examples.test.ts` (create)

**Interfaces:**
- Consumes: `ContractOutput`, `verifyOutputs`, `validateFleetSpec`, tool `OutputSchema`.
- Produces: optional `ContractOutput.schema?: JsonOutputSchema` where:

```ts
export interface JsonOutputSchema {
  required_keys?: string[];
  number_keys?: string[];
}
```

`json` contract checks: valid JSON, object when schema present, all `required_keys` present, all `number_keys` exist and are numbers or arrays of numbers.

- [ ] **Step 1: Write failing tests**

Create `test/contracts-json-schema.test.ts`:

```ts
it("fails json contract when required key missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
  await writeFile(join(dir, "numbers.json"), JSON.stringify({ values: [1, 2] }), "utf-8");
  const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { required_keys: ["values", "source"] } }] });
  expect(r.ok).toBe(false);
  expect(r.checks[0].error).toContain("missing required key");
});

it("passes numeric values schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
  await mkdir(join(dir, "output"), { recursive: true });
  await writeFile(join(dir, "output", "numbers.json"), JSON.stringify({ values: [1, 2, 3] }), "utf-8");
  const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { required_keys: ["values"], number_keys: ["values"] } }] });
  expect(r.ok).toBe(true);
});
```

Add `test/examples.test.ts` that loads `examples/json-number-pipeline.json`, runs `validateFleetSpec`, and expects ok.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/contracts-json-schema.test.ts test/dag-json-schema.test.ts test/examples.test.ts`
Expected: FAIL (`schema` unsupported, example missing).

- [ ] **Step 3: Implement schema type and validation**

In `src/types.ts` add `JsonOutputSchema` and `schema?: JsonOutputSchema` to `ContractOutput`. In `src/tools.ts` `OutputSchema`, add optional `schema` object with optional `required_keys: string[]` and `number_keys: string[]`. In `src/dag.ts`, validate schema shape: keys are arrays of non-empty strings; `schema` only allowed with `kind: "json"`.

In `src/contracts.ts` json case:

```ts
const parsed = JSON.parse(content);
if (o.schema) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("json schema requires an object");
  const obj = parsed as Record<string, unknown>;
  for (const key of o.schema.required_keys ?? []) if (!(key in obj)) return fail(`missing required key "${key}"`);
  for (const key of o.schema.number_keys ?? []) {
    const v = obj[key];
    const ok = typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "number"));
    if (!ok) return fail(`key "${key}" must be a number or number[]`);
  }
}
```

Update `src/prompts.ts` output obligations to print schema requirements for JSON outputs.

- [ ] **Step 4: Add dead-simple example**

Create `examples/json-number-pipeline.json`:

```json
{
  "fleet_name": "json-number-pipeline",
  "type": "dag",
  "config": { "max_concurrent": 2 },
  "workers": [
    {
      "id": "write-numbers",
      "type": "write",
      "task": "Write output/numbers.json containing exactly {\"values\":[3,5,8]}. No markdown. No commentary.",
      "depends_on": [],
      "outputs": [{ "path": "output/numbers.json", "kind": "json", "required": true, "schema": { "required_keys": ["values"], "number_keys": ["values"] } }]
    },
    {
      "id": "add-numbers",
      "type": "write",
      "task": "Read output/numbers.json from write-numbers. Write output/sum.json containing {\"operation\":\"add\",\"result\":16}.",
      "depends_on": ["write-numbers"],
      "outputs": [{ "path": "output/sum.json", "kind": "json", "required": true, "schema": { "required_keys": ["operation", "result"], "number_keys": ["result"] } }]
    },
    {
      "id": "subtract-numbers",
      "type": "write",
      "task": "Read output/numbers.json from write-numbers. Write output/difference.json containing {\"operation\":\"subtract\",\"result\":-10} using first value minus the rest.",
      "depends_on": ["write-numbers"],
      "outputs": [{ "path": "output/difference.json", "kind": "json", "required": true, "schema": { "required_keys": ["operation", "result"], "number_keys": ["result"] } }]
    },
    {
      "id": "synthesize",
      "type": "write",
      "task": "Read output/sum.json and output/difference.json. Write output/final.json containing {\"sum\":16,\"difference\":-10,\"combined\":6} where combined = sum + difference.",
      "depends_on": ["add-numbers", "subtract-numbers"],
      "outputs": [{ "path": "output/final.json", "kind": "json", "required": true, "schema": { "required_keys": ["sum", "difference", "combined"], "number_keys": ["sum", "difference", "combined"] } }]
    }
  ]
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/contracts-json-schema.test.ts test/dag-json-schema.test.ts test/examples.test.ts test/contracts.test.ts test/dag.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tools.ts src/dag.ts src/contracts.ts src/prompts.ts examples/json-number-pipeline.json test/contracts-json-schema.test.ts test/dag-json-schema.test.ts test/examples.test.ts
git commit -m "feat(fleet): JSON output schemas and numeric pipeline example"
```

---

### Task 5: Enforce repo-relative output ownership beyond worktrees

**Files:**
- Modify: `src/dag.ts`
- Test: `test/dag.test.ts`

**Interfaces:**
- Consumes: existing `findWorktreeOwnershipConflicts`.
- Produces: `findRepoOutputOwnershipConflicts(workers: WorkerSpec[]): string[]` applied to all workers, not only `worktree: true`.

- [ ] **Step 1: Write failing test**

Add to `test/dag.test.ts`:

```ts
it("rejects overlapping repo-relative outputs without ordered handoff", () => {
  const fleet = baseFleet([
    worker("a", { outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
    worker("b", { outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
  ]);
  const v = validateFleetSpec(fleet);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.errors.join("\n")).toContain("repo output ownership conflict");
});

it("allows overlapping repo-relative output with ordered handoff", () => {
  const fleet = baseFleet([
    worker("a", { outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
    worker("b", { depends_on: ["a"], outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
  ]);
  const v = validateFleetSpec(fleet);
  expect(v.ok).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dag.test.ts`
Expected: FAIL.

- [ ] **Step 3: Generalize ownership validation**

Refactor `findWorktreeOwnershipConflicts` into `findRepoOutputOwnershipConflicts(workers)` that checks any repo-relative output claimed by multiple workers and requires direct ordered handoff (`a.depends_on.includes(b)` or reverse). Call it unconditionally in `validateFleetSpec`. Keep error prefix `repo output ownership conflict:`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/dag.test.ts test/dag-loop.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dag.ts test/dag.test.ts
git commit -m "feat(fleet): reject repo output ownership conflicts"
```

---

### Task 6: Make worktree recreation and spec persistence safe

**Files:**
- Modify: `src/worktree.ts`
- Modify: `src/edits.ts`
- Modify: `src/insert.ts`
- Test: `test/worktree.test.ts`
- Test: `test/edits-atomic.test.ts` (create)

**Interfaces:**
- Consumes: `createWorktree`, `prepareIntegratorWorktree`, `removeWorktree`, `persistSpec`, `persistFleetJson`.
- Produces:
  - `removeBranch(baseRepo, branch): Promise<void>` best-effort `git branch -D`.
  - `createWorktree` removes stale branch before `git worktree add -b`.
  - shared `persistFleetJson(fleet)` helper in `src/fleet-store.ts` used by edits and insert.

- [ ] **Step 1: Write failing tests**

Add to `test/worktree.test.ts`:

```ts
it("recreates a worktree when the deterministic branch already exists", async () => {
  const repo = await initRepo();
  const fleetRoot = join(repo, ".fleet", "demo-20260101000000");
  await createWorktree({ baseRepo: repo, fleetName: "demo", nodeId: "n1", fleetRoot });
  await createWorktree({ baseRepo: repo, fleetName: "demo", nodeId: "n1", fleetRoot });
});
```

Create `test/edits-atomic.test.ts` asserting `editNode` uses tmp+rename by spying on `rename` calls or by concurrently editing and reading valid JSON.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/worktree.test.ts test/edits-atomic.test.ts`
Expected: FAIL (branch exists; persistSpec non-atomic).

- [ ] **Step 3: Implement worktree branch cleanup**

In `src/worktree.ts`:

```ts
export async function removeBranch(baseRepo: string, branch: string): Promise<void> {
  await execFileP("git", ["branch", "-D", branch], { cwd: baseRepo }).catch(() => {});
}
```

Call `await removeBranch(opts.baseRepo, branch)` after `removeWorktree` in both `createWorktree` and `prepareIntegratorWorktree` before `git worktree add -b`.

- [ ] **Step 4: Unify atomic fleet spec persistence**

Move `persistFleetJson` from `src/insert.ts` into `src/fleet-store.ts` and export it. Update `src/insert.ts` and `src/edits.ts` to import and use it. Delete local non-atomic `persistSpec`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/worktree.test.ts test/edits-atomic.test.ts test/edits.test.ts test/insert.test.ts test/scheduler-relaunch.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worktree.ts src/edits.ts src/insert.ts src/fleet-store.ts test/worktree.test.ts test/edits-atomic.test.ts
git commit -m "fix(fleet): safe worktree recreation and atomic spec writes"
```

---

### Task 7: Final docs + full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ontology.md`
- Test: `test/e2e.test.ts`
- Test: `test/examples.test.ts`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: README section for JSON number pipeline and `fleet_models`; ontology rule: producer/consumer JSON contracts must name exact keys.

- [ ] **Step 1: Write failing docs test**

Extend `test/examples.test.ts`:

```ts
it("README documents json number pipeline and fleet_models", async () => {
  const readme = await readFile("README.md", "utf-8");
  expect(readme).toContain("examples/json-number-pipeline.json");
  expect(readme).toContain("fleet_models");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/examples.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update docs**

README: add `fleet_models` to tools table, add Quickstart variant using `examples/json-number-pipeline.json`, document `schema` for JSON outputs. `docs/ontology.md`: add short rule for JSON producer/consumer contracts.

- [ ] **Step 4: Run full verification**

Run: `npm test`
Expected: all tests pass.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/ontology.md test/e2e.test.ts test/examples.test.ts
git commit -m "docs(fleet): JSON number pipeline quickstart and contracts"
```
