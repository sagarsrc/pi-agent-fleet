import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runWorker, type SessionFactory, type WorkerEvent } from "./runner.js";

export const PLANNER_WORKER_ID = "planner";

export interface FleetDesignResult {
  ok: boolean;
  error?: string;
  draft?: unknown;
  rationale?: string;
  turns: number;
  tokens: number;
}

export function slugifyFleetName(requirements: string): string {
  const slug = requirements
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "fleet";
}

export function buildPlannerPrompt(opts: { requirements: string; fleetName: string; plannerDir: string }): string {
  const { requirements, fleetName, plannerDir } = opts;
  return `# Fleet designer

You design a DAG-of-agents "fleet" for the pi fleet runner. You produce ONE definition file plus a rationale.

## Requirements from the user

${requirements}

## Your outputs (both REQUIRED)

- ${plannerDir}/output/fleet.json — the fleet definition. A single raw JSON object, no markdown fences, no commentary.
- ${plannerDir}/output/rationale.md — why this decomposition, what each node does, why the gate choice.

## Fleet JSON schema

{
  "fleet_name": "${fleetName}",
  "type": "dag",
  "config": {
    "max_concurrent": <integer >= 1, optional>,
    "warn_cost_usd": <number >= 0, optional>,
    "loop": { "gate": "reviewer" | "none", "max_iterations": <int >= 1>, "lgtm_count": <optional int, reviewer gate only> }
  },
  "workers": [
    {
      "id": "kebab-case",
      "type": "research" | "code-run" | "reviewer" | "write" | "read-only",
      "task": "full self-contained instructions for the worker",
      "depends_on": ["upstream-worker-ids"],
      "outputs": [{ "path": "output/<file> or repo-relative path", "kind": "markdown" | "file-exists" | "verdict" | "json" | "yaml", "required": true }],
      "iterate": true,
      "worktree": false
    }
  ]
}

config, outputs, iterate, worktree, and loop are optional (defaults: max_concurrent 4, iterate true, worktree false).

## Hard rules (violations fail validation)

1. fleet_name and worker ids are kebab-case; ids unique.
2. depends_on references existing workers only; the graph must be acyclic.
3. Do NOT set "model" or "effort" fields anywhere — the runner assigns models and effort.
4. With gate "reviewer": exactly one worker declares an output of kind "verdict"; that worker must be a sink (nothing depends on it) and must iterate. Its task must instruct: the review file starts with exactly one of \`verdict: lgtm\` / \`verdict: iterate\` / \`verdict: escalate\`, followed by specific actionable per-worker feedback.
5. With gate "none": at least one worker must have iterate enabled (default true counts).
6. A worker with iterate: false may not depend on a worker that iterates.
7. Output paths: "output/..." resolves under the worker dir (use for notes, reports, verdicts); any other relative path is repo-relative (use for code edits). No absolute paths, no "..".
8. Worker types and tools: research (read/web/write), code-run (full coding tools), reviewer (read/write), write (read/write), read-only (read only).

## Design guidance

- Decompose into independent layer-0 research/analysis nodes that run in parallel, then synthesis/writer nodes, then optionally a reviewer gate.
- Prefer few high-value nodes over many trivial ones; 3-10 workers is typical.
- Each task must be self-contained: what to produce, where, format, constraints, done-criteria.
- Use a loop with gate "reviewer" only when iterative refinement against feedback makes sense; otherwise a single pass is cheaper.
`;
}

export function sanitizeDraft(draft: unknown): unknown {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) return draft;
  const d = draft as Record<string, unknown>;
  if (typeof d.config === "object" && d.config !== null && !Array.isArray(d.config)) {
    const cfg = d.config as Record<string, unknown>;
    delete cfg.model;
    delete cfg.effort;
  }
  if (Array.isArray(d.workers)) {
    for (const w of d.workers as Array<Record<string, unknown>>) {
      if (typeof w === "object" && w !== null) {
        delete w.model;
        delete w.effort;
      }
    }
  }
  return d;
}

export async function runFleetDesign(opts: {
  requirements: string;
  fleetName: string;
  designRoot: string;
  repoCwd: string;
  sessionFactory?: SessionFactory;
  onEvent?: (e: WorkerEvent) => void;
}): Promise<FleetDesignResult> {
  const plannerDir = join(opts.designRoot, "planner");
  await mkdir(join(plannerDir, "output"), { recursive: true });
  const prompt = buildPlannerPrompt({ requirements: opts.requirements, fleetName: opts.fleetName, plannerDir });
  const res = await runWorker({
    nodeId: PLANNER_WORKER_ID,
    worker: { id: PLANNER_WORKER_ID, type: "write", task: "design a fleet DAG", depends_on: [], outputs: [] },
    prompt,
    repoCwd: opts.repoCwd,
    sessionDir: plannerDir,
    sessionFactory: opts.sessionFactory,
    thinkingLevel: "medium",
    onEvent: opts.onEvent ?? (() => {}),
  });
  if (!res.ok) {
    return { ok: false, error: res.error ?? "planner session failed", turns: res.turns, tokens: res.tokens };
  }
  let raw: string;
  try {
    raw = await readFile(join(plannerDir, "output", "fleet.json"), "utf-8");
  } catch {
    return { ok: false, error: "planner did not write output/fleet.json", turns: res.turns, tokens: res.tokens };
  }
  let draft: unknown;
  try {
    draft = sanitizeDraft(JSON.parse(raw));
  } catch (e) {
    return { ok: false, error: `fleet.json is not valid JSON: ${(e as Error).message}`, turns: res.turns, tokens: res.tokens };
  }
  let rationale: string | undefined;
  try {
    rationale = await readFile(join(plannerDir, "output", "rationale.md"), "utf-8");
  } catch {
    // rationale is optional in the result
  }
  return { ok: true, draft, rationale, turns: res.turns, tokens: res.tokens };
}
