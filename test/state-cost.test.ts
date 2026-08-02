import { describe, expect, it } from "vitest";
import { initFleetState, patchNode, resetForIteration, resetForRelaunch, snapshotIteration } from "../src/state.js";
import type { FleetSpec, IterationSnapshot, NodeState } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [
    { id: "a", type: "write", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: [], outputs: [], iterate: false },
  ],
};

describe("state cost accumulation", () => {
  it("patchNode includes archived iteration node costs in fleet total", () => {
    const s = initFleetState(spec);
    const archived: IterationSnapshot = {
      n: 1, verdict: null, verdict_body: null,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      nodes: {
        a: { ...s.nodes.a, status: "completed", cost_usd_estimate: 0.1 } as NodeState,
      },
    };
    const withIter = { ...s, iterations: [archived] };
    const s2 = patchNode("/unused", withIter, "a", { status: "completed", cost_usd_estimate: 0.05 });
    expect(s2.cost_usd_estimate).toBeCloseTo(0.15, 6);
  });

  it("resetForRelaunch preserves fleet cost when live costs are already archived", () => {
    const s = initFleetState(spec);
    const completed: NodeState = {
      status: "completed",
      turns: 1,
      tokens: 5,
      cost_usd_estimate: 0.2,
      produced_outputs: [],
    };
    const s1 = {
      ...s,
      nodes: { a: completed, b: { ...completed, cost_usd_estimate: 0.1 } },
    };
    const afterSnap = snapshotIteration(s1, null, null, spec);
    const failed = patchNode("/unused", afterSnap, "a", { status: "failed" });
    const before = failed.cost_usd_estimate;
    const r = resetForRelaunch(failed, spec, "a");
    expect(r.cost_usd_estimate).toBeCloseTo(before, 6);
  });
});
