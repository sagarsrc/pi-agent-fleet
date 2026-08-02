import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../src/prompts.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec, FleetState, IterationSnapshot } from "../src/types.js";

const baseSpec = (workers: FleetSpec["workers"]): FleetSpec => ({
  fleet_name: "loop-prompts",
  type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers,
});

const iterationSnapshot = (
  n: number,
  verdict: "lgtm" | "iterate" | "escalate" | null,
  verdictBody: string | null,
): IterationSnapshot => ({
  n,
  verdict,
  verdict_body: verdictBody,
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  nodes: {},
});

const atIteration = (spec: FleetSpec, iteration: number, iterations: IterationSnapshot[]): FleetState => ({
  ...initFleetState(spec),
  iteration,
  iterations,
});

describe("buildWorkerPrompt loop extensions", () => {
  it("iteration 1: no feedback section", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["build"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "build", type: "code-run", task: "Build", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }] },
    ]);
    const state = initFleetState(spec);
    const p = buildWorkerPrompt({ spec, state, workerId: "build", fleetRoot: "/f" });
    expect(p).not.toContain("## Reviewer feedback");
    expect(p).not.toContain("## Previous reviews");
  });

  it("iteration 2 replay node gets feedback after Task", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["build"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "build", type: "code-run", task: "Build", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }] },
    ]);
    const state = atIteration(spec, 2, [iterationSnapshot(1, "iterate", "fix x")]);
    const p = buildWorkerPrompt({ spec, state, workerId: "build", fleetRoot: "/f" });
    expect(p).toContain("## Reviewer feedback (iteration 1)\n\nfix x");
    expect(p.indexOf("## Reviewer feedback")).toBeLessThan(p.indexOf("## The fleet DAG"));
  });

  it("run-once node gets no feedback", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["setup"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "setup", type: "code-run", task: "Setup", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], iterate: false },
    ]);
    const state = atIteration(spec, 2, [iterationSnapshot(1, "iterate", "fix setup")]);
    const p = buildWorkerPrompt({ spec, state, workerId: "setup", fleetRoot: "/f" });
    expect(p).not.toContain("## Reviewer feedback");
  });

  it("reviewer gets previous reviews history", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["build"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "build", type: "code-run", task: "Build", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }] },
    ]);
    const state = atIteration(spec, 3, [
      iterationSnapshot(1, "iterate", "do A"),
      iterationSnapshot(2, "lgtm", "good"),
    ]);
    const p = buildWorkerPrompt({ spec, state, workerId: "reviewer", fleetRoot: "/f" });
    expect(p).toContain("## Previous reviews");
    expect(p).toContain("### Iteration 1 — verdict: iterate\ndo A");
    expect(p).toContain("### Iteration 2 — verdict: lgtm\ngood");
  });

  it("worktree node gets directive with paths", () => {
    const spec = baseSpec([
      { id: "w1", type: "code-run", task: "Work", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
    ]);
    const state = initFleetState(spec);
    const p = buildWorkerPrompt({ spec, state, workerId: "w1", fleetRoot: "/f/.fleet/my-fleet-20260801120000" });
    expect(p).toContain("## Your worktree");
    expect(p).toContain("git worktree add /f/.fleet/my-fleet-20260801120000/worktrees/w1 -b fleet/my-fleet-20260801120000/w1");
    expect(p).toContain("Make ALL repo changes inside the worktree.");
  });

  it("verdict-output worker gets verdict format instruction", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["build"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "build", type: "code-run", task: "Build", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }] },
    ]);
    const state = initFleetState(spec);
    const p = buildWorkerPrompt({ spec, state, workerId: "reviewer", fleetRoot: "/f" });
    expect(p).toContain("## Writing your verdict");
    expect(p).toContain("verdict: lgtm");
    expect(p.indexOf("## Writing your verdict")).toBeLessThan(p.indexOf("## Your output obligations"));
  });

  it("verdict example lines are flush-left", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["build"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "build", type: "code-run", task: "Build", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }] },
    ]);
    const state = initFleetState(spec);
    const p = buildWorkerPrompt({ spec, state, workerId: "reviewer", fleetRoot: "/f" });
    const lines = p.split("\n");
    expect(lines).toContain("verdict: lgtm");
    expect(lines).toContain("verdict: iterate");
    expect(lines).toContain("verdict: escalate");
    expect(lines).not.toContain("  verdict: lgtm");
  });

  it("non-verdict worker does not get verdict format instruction", () => {
    const spec = baseSpec([
      { id: "reviewer", type: "reviewer", task: "Review", depends_on: ["build"], outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }] },
      { id: "build", type: "code-run", task: "Build", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }] },
    ]);
    const state = initFleetState(spec);
    const p = buildWorkerPrompt({ spec, state, workerId: "build", fleetRoot: "/f" });
    expect(p).not.toContain("## Writing your verdict");
    expect(p).not.toContain("verdict: lgtm");
  });

  it("downstream of worktree dep sees worktree line", () => {
    const spec = baseSpec([
      { id: "wt", type: "code-run", task: "Work", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
      { id: "down", type: "code-run", task: "Merge", depends_on: ["wt"], outputs: [{ path: "src/y.ts", kind: "file-exists", required: true }] },
    ]);
    const state = initFleetState(spec);
    const p = buildWorkerPrompt({ spec, state, workerId: "down", fleetRoot: "/f/.fleet/my-fleet-20260801120000" });
    expect(p).toContain("- wt worktree: /f/.fleet/my-fleet-20260801120000/worktrees/wt (branch fleet/my-fleet-20260801120000/wt)");
    expect(p).toContain("— merge or cherry-pick from here if you need its repo changes");
  });
});
