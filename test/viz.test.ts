import { describe, expect, it } from "vitest";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { dagNeedsFileFallback, renderDag } from "../src/viz.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "research", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "build", type: "code-run", task: "t", depends_on: ["research"], outputs: [] },
    { id: "review", type: "reviewer", task: "t", depends_on: ["build"], outputs: [] },
  ],
};

describe("renderDag", () => {
  it("renders layers and edges", () => {
    const out = renderDag(spec);
    expect(out).toContain("research");
    expect(out).toContain("build");
    expect(out).toContain("research --▶ build");
    expect(out).toContain("build --▶ review");
  });
  it("annotates statuses when state given", () => {
    const s = initFleetState(spec);
    s.nodes.research.status = "completed";
    s.nodes.build.status = "running";
    const out = renderDag(spec, s);
    expect(out).toContain("✓ research");
    expect(out).toContain("◌ build");
  });
  it("flags fallback for wide graphs", () => {
    expect(dagNeedsFileFallback(spec, 200)).toBe(false);
    const many: FleetSpec = structuredClone(spec);
    for (let i = 0; i < 20; i++) {
      many.workers.push({ id: `w-${i}`, type: "write", task: "t", depends_on: [], outputs: [] });
    }
    expect(dagNeedsFileFallback(many, 200)).toBe(true);
  });

  it("renderDag falls back to (default) model label", () => {
    const s: FleetSpec = {
      fleet_name: "t", type: "dag",
      config: { max_concurrent: 1 },
      workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
    };
    expect(renderDag(s)).toContain("a (default)");
  });
});
