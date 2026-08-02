import { describe, expect, it } from "vitest";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec, FleetState, IterationSnapshot, NodeState } from "../src/types.js";
import { buildWidgetLines } from "../src/ui.js";

const loopSpec: FleetSpec = {
  fleet_name: "loop",
  type: "dag",
  config: {
    max_concurrent: 2,
    model: "k2p6",
    loop: { gate: "reviewer", max_iterations: 5, lgtm_count: 2 },
  },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "reviewer", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

const oneShotSpec: FleetSpec = {
  fleet_name: "t",
  type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

function loopStateWithSnapshots(): FleetState {
  const state = initFleetState(loopSpec);
  const nodeBase: NodeState = {
    status: "completed",
    turns: 1,
    tokens: 100,
    cost_usd_estimate: 0.21,
    produced_outputs: [],
  };
  const snap1: IterationSnapshot = {
    n: 1,
    verdict: "iterate",
    verdict_body: "needs more detail",
    started_at: new Date(Date.now() - 2000).toISOString(),
    ended_at: new Date(Date.now() - 1000).toISOString(),
    nodes: {
      a: { ...nodeBase, produced_outputs: [] },
      b: { ...nodeBase, produced_outputs: [] },
    },
  };
  const snap2: IterationSnapshot = {
    n: 2,
    verdict: "iterate",
    verdict_body: "still vague",
    started_at: new Date(Date.now() - 900).toISOString(),
    ended_at: new Date().toISOString(),
    nodes: {
      a: { ...nodeBase, tokens: 120, cost_usd_estimate: 0.25 },
      b: { ...nodeBase, tokens: 80, cost_usd_estimate: 0.17 },
    },
  };
  return {
    ...state,
    iteration: 2,
    lgtm_streak: 0,
    cost_usd_estimate: 0.42,
    iterations: [snap1, snap2],
    nodes: snap2.nodes,
  };
}

describe("buildWidgetLines loop", () => {
  it("loop fleet header shows iteration, verdict, streak", () => {
    const state = loopStateWithSnapshots();
    const lines = buildWidgetLines(loopSpec, state);
    expect(lines[0]).toContain("iteration 2/5");
    expect(lines[0]).toContain("last verdict: iterate");
    expect(lines[0]).toContain("streak 0/2");
    expect(lines[0]).toContain("(2/2 done");
  });

  it("one-shot fleet header unchanged", () => {
    let state = initFleetState(oneShotSpec);
    state = patchNode("/x", state, "a", { status: "running", turns: 3, tokens: 1200 });
    const lines = buildWidgetLines(oneShotSpec, state);
    expect(lines[0]).toBe("● fleet: t  (0/2 done · $0.00)");
  });

  it("gate none loop header omits streak", () => {
    const gateNoneSpec: FleetSpec = {
      ...loopSpec,
      config: { ...loopSpec.config, loop: { gate: "none", max_iterations: 5, lgtm_count: 1 } },
    };
    const state = loopStateWithSnapshots();
    const lines = buildWidgetLines(gateNoneSpec, state);
    expect(lines[0]).toContain("iteration 2/5");
    expect(lines[0]).toContain("last verdict: iterate");
    expect(lines[0]).not.toContain("streak");
  });
});
