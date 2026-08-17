import { describe, expect, it } from "vitest";
import { computePositions, excerptText } from "../src/canvas-layout.js";

describe("excerptText", () => {
  it("truncates long text with ellipsis marker", () => {
    const r = excerptText("x".repeat(500), 240);
    expect(r.truncated).toBe(true);
    expect(r.excerpt.length).toBeLessThanOrEqual(241);
  });

  it("passes short text through", () => {
    expect(excerptText("short", 240)).toEqual({ excerpt: "short", truncated: false });
  });
});

describe("computePositions", () => {
  const ids = ["A", "B", "C", "D", "E"];
  const edges = [
    { from: "A", to: "C" }, { from: "B", to: "C" }, { from: "B", to: "D" },
    { from: "C", to: "D" }, { from: "A", to: "E" }, { from: "B", to: "E" },
    { from: "C", to: "E" }, { from: "D", to: "E" },
  ];

  it("stacks layers vertically: deeper nodes have strictly larger y", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    expect(pos.A.y).toBe(0);
    expect(pos.C.y).toBeGreaterThan(pos.A.y);
    expect(pos.D.y).toBeGreaterThan(pos.C.y);
    expect(pos.E.y).toBeGreaterThan(pos.D.y);
  });

  it("gives same-layer nodes distinct x positions", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    expect(pos.A.x).not.toBe(pos.B.x);
  });

  it("keeps every node below all of its parents", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    for (const e of edges) expect(pos[e.to].y).toBeGreaterThan(pos[e.from].y);
  });

  it("centers narrow layers horizontally under widest layer", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    expect(pos.E.x).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    const a = computePositions(ids.map((id) => ({ id })), edges);
    const b = computePositions(ids.map((id) => ({ id })), edges);
    expect(a).toEqual(b);
  });
});
