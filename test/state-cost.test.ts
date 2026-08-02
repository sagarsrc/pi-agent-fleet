import { describe, expect, it } from "vitest";
import { initFleetState, patchNode, resetForIteration } from "../src/state.js";
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

  it("resetForIteration preserves archived costs while resetting live iterate nodes", () => {
    const s = initFleetState(spec);
    const archived: IterationSnapshot = {
      n: 1, verdict: null, verdict_body: null,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      nodes: {
        a: { ...s.nodes.a, status: "completed", cost_usd_estimate: 0.2 } as NodeState,
      },
    };
    const s1 = { ...s, iterations: [archived] };
    const s2 = resetForIteration(s1, spec);
    expect(s2.nodes.a.cost_usd_estimate).toBe(0);
    expect(s2.nodes.b.cost_usd_estimate).toBe(0);
    expect(s2.cost_usd_estimate).toBeCloseTo(0.2, 6);
  });
});
