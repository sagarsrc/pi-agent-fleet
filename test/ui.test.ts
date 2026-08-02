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
