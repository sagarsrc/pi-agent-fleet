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

  it("falls back to (default) model label", () => {
    const s: FleetSpec = {
      fleet_name: "t", type: "dag",
      config: { max_concurrent: 1 },
      workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
    };
    const lines = buildWidgetLines(s, initFleetState(s));
    expect(lines[1]).toContain("(default)");
  });
});

describe("widget stats, truncation, spinner", () => {
  const many: FleetSpec = {
    fleet_name: "big",
    type: "dag",
    config: { max_concurrent: 4, model: "m" },
    workers: Array.from({ length: 15 }, (_, i) => ({
      id: `w${i}`, type: "research" as const, task: "t", depends_on: [], outputs: [],
    })),
  };

  it("completed nodes show turns, tokens, cost", () => {
    let s = initFleetState(spec);
    s = patchNode("/x", s, "a", { status: "completed", turns: 5, tokens: 1200, cost_usd_estimate: 0.03 });
    const lines = buildWidgetLines(spec, s);
    expect(lines[1]).toContain("✓ a");
    expect(lines[1]).toContain("5 turns");
    expect(lines[1]).toContain("1.2k tok");
    expect(lines[1]).toContain("$0.03");
  });

  it("caps lines at maxLines with overflow summary", () => {
    const lines = buildWidgetLines(many, initFleetState(many));
    expect(lines.length).toBe(12);
    expect(lines[11]).toContain("+5 more");
    expect(lines[11]).toContain("0/15 done");
  });

  it("keeps running nodes visible under truncation", () => {
    let s = initFleetState(many);
    s = patchNode("/x", s, "w14", { status: "running", turns: 2, tokens: 500 });
    const lines = buildWidgetLines(many, s);
    expect(lines.some((l) => l.includes("w14"))).toBe(true);
    expect(lines.length).toBe(12);
  });

  it("respects a smaller maxLines", () => {
    const lines = buildWidgetLines(many, initFleetState(many), { maxLines: 6 });
    expect(lines.length).toBe(6);
    expect(lines[5]).toContain("+11 more");
  });

  it("spinnerFrame animates the running icon", () => {
    const s = patchNode("/x", initFleetState(spec), "a", { status: "running" });
    expect(buildWidgetLines(spec, s, { spinnerFrame: 0 })[1]).toContain("⠋ a");
    expect(buildWidgetLines(spec, s, { spinnerFrame: 2 })[1]).toContain("⠹ a");
  });

  it("header says lgtm streak", () => {
    const loopSpec: FleetSpec = {
      fleet_name: "loop", type: "dag",
      config: { max_concurrent: 2, model: "m", loop: { gate: "reviewer", max_iterations: 5, lgtm_count: 2 } },
      workers: [
        { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
        { id: "b", type: "reviewer", task: "t", depends_on: ["a"], outputs: [] },
      ],
    };
    const lines = buildWidgetLines(loopSpec, initFleetState(loopSpec));
    expect(lines[0]).toContain("lgtm streak 0/2");
  });

  it("clamps degenerate maxLines to 3", () => {
    const lines = buildWidgetLines(many, initFleetState(many), { maxLines: 2 });
    expect(lines.length).toBe(3);
  });

  it("renders nodes missing from state as pending without throwing", () => {
    const grown: FleetSpec = { ...spec, workers: [...spec.workers, { id: "c", type: "write", task: "t", depends_on: ["b"], outputs: [] }] };
    const lines = buildWidgetLines(grown, initFleetState(spec)); // state lacks c
    expect(lines.some((l) => l.includes("○ c"))).toBe(true);
  });
});

describe("loop cost fallback", () => {
  it("shows last-iteration cost for completed nodes when live cost is zeroed", () => {
    const loopSpec: FleetSpec = {
      fleet_name: "loop", type: "dag",
      config: { max_concurrent: 2, model: "m", loop: { gate: "none", max_iterations: 2, lgtm_count: 1 } },
      workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
    };
    let s = initFleetState(loopSpec);
    s = patchNode("/x", s, "a", { status: "completed", turns: 3, tokens: 900, cost_usd_estimate: 0.05 });
    // simulate snapshotIteration zeroing live cost and archiving the old one
    const archived = { ...s.nodes.a };
    s = {
      ...s,
      nodes: { a: { ...s.nodes.a, cost_usd_estimate: 0 } },
      iterations: [{ n: 1, verdict: null, verdict_body: null, started_at: "t0", ended_at: "t1", nodes: { a: archived } }],
    };
    const lines = buildWidgetLines(loopSpec, s);
    expect(lines[1]).toContain("$0.05");
  });
});
