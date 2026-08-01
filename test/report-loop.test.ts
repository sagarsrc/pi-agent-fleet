import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReport } from "../src/report.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec, FleetState, IterationSnapshot, NodeState } from "../src/types.js";

const loopSpec: FleetSpec = {
  fleet_name: "loop",
  type: "dag",
  config: {
    max_concurrent: 1,
    model: "k2p6",
    loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 1 },
  },
  workers: [
    { id: "a", type: "write", task: "t", depends_on: [], outputs: [] },
    { id: "rev", type: "reviewer", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

function loopState(): FleetState {
  const state = initFleetState(loopSpec);
  const nodeBase: NodeState = {
    status: "completed",
    turns: 1,
    tokens: 100,
    cost_usd_estimate: 0.1,
    produced_outputs: [],
  };
  const snap: IterationSnapshot = {
    n: 1,
    verdict: "iterate",
    verdict_body: "expand the section on auth",
    started_at: new Date(Date.now() - 5000).toISOString(),
    ended_at: new Date(Date.now() - 1000).toISOString(),
    nodes: {
      a: { ...nodeBase, tokens: 120, cost_usd_estimate: 0.12 },
      rev: { ...nodeBase, tokens: 80, cost_usd_estimate: 0.08 },
    },
  };
  return {
    ...state,
    status: "paused",
    iteration: 1,
    lgtm_streak: 0,
    cost_usd_estimate: 0.2,
    iterations: [snap],
    nodes: snap.nodes,
  };
}

describe("writeReport loop", () => {
  it("report includes iterations table and verdict bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-loop-"));
    const md = await writeReport({ spec: loopSpec, state: loopState(), fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("## Iterations");
    expect(md).toContain("| 1 | iterate |");
    expect(md).toContain("expand the section on auth");
  });

  it("report includes per-iteration per-node detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-loop-"));
    const md = await writeReport({ spec: loopSpec, state: loopState(), fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("### Iteration 1");
    expect(md).toContain("- a: completed · 1 turns · 120 tok");
    expect(md).toContain("- rev: completed · 1 turns · 80 tok");
  });

  it("report lists worktree branches for one-shot fleets", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-worktree-oneshot-"));
    const spec: FleetSpec = {
      fleet_name: "oneshot",
      type: "dag",
      config: { max_concurrent: 1, model: "k2p6" },
      workers: [
        { id: "builder-a", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
      ],
    };
    const nodeBase: NodeState = {
      status: "completed",
      turns: 1,
      tokens: 100,
      cost_usd_estimate: 0.1,
      produced_outputs: [],
    };
    const state: FleetState = {
      ...initFleetState(spec),
      status: "completed",
      iteration: 1,
      lgtm_streak: 0,
      cost_usd_estimate: 0.1,
      iterations: [],
      nodes: { "builder-a": { ...nodeBase } },
    };
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    const base = root.split("/").pop()!;
    expect(md).not.toContain("## Iterations");
    expect(md).toContain("## Worktree branches");
    expect(md).toContain(`fleet/${base}/builder-a`);
  });

  it("report lists worktree branches for loop fleets", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-worktree-"));
    const spec: FleetSpec = {
      ...loopSpec,
      workers: [
        { id: "builder-a", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
        { id: "builder-b", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
      ],
    };
    const nodeBase: NodeState = {
      status: "completed",
      turns: 1,
      tokens: 100,
      cost_usd_estimate: 0.1,
      produced_outputs: [],
    };
    const snap: IterationSnapshot = {
      n: 1,
      verdict: "iterate",
      verdict_body: "body",
      started_at: new Date(Date.now() - 5000).toISOString(),
      ended_at: new Date(Date.now() - 1000).toISOString(),
      nodes: {
        "builder-a": { ...nodeBase },
        "builder-b": { ...nodeBase },
      },
    };
    const state: FleetState = {
      ...initFleetState(spec),
      status: "paused",
      iteration: 1,
      lgtm_streak: 0,
      cost_usd_estimate: 0.2,
      iterations: [snap],
      nodes: snap.nodes,
    };
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    const base = root.split("/").pop()!;
    expect(md).toContain("## Worktree branches");
    expect(md).toContain(`fleet/${base}/builder-a`);
    expect(md).toContain(`fleet/${base}/builder-b`);
  });
});
