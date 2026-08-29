import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computePositions, excerptText, estimateNodeHeight } from "../src/canvas-layout.js";

describe("excerptText", () => {
  it("truncates long text with ellipsis marker", () => {
    const r = excerptText("x".repeat(500), 240);
    expect(r.truncated).toBe(true);
    expect(r.excerpt.length).toBeLessThanOrEqual(241);
  });

  it("passes short text through", () => {
    expect(excerptText("short", 240)).toEqual({ excerpt: "short", truncated: false });
  });

  it("does not truncate when text length equals limit", () => {
    expect(excerptText("x".repeat(240), 240)).toEqual({ excerpt: "x".repeat(240), truncated: false });
  });

  it("handles empty text", () => {
    expect(excerptText("", 240)).toEqual({ excerpt: "", truncated: false });
  });
});

describe("computePositions", () => {
  const ids = ["A", "B", "C", "D", "E"];
  const edges = [
    { from: "A", to: "C" }, { from: "B", to: "C" }, { from: "B", to: "D" },
    { from: "C", to: "D" }, { from: "A", to: "E" }, { from: "B", to: "E" },
    { from: "C", to: "E" }, { from: "D", to: "E" },
  ];

  it("lays hierarchy left to right: deeper nodes have strictly larger x", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    expect(pos.A.x).toBe(0);
    expect(pos.C.x).toBeGreaterThan(pos.A.x);
    expect(pos.D.x).toBeGreaterThan(pos.C.x);
    expect(pos.E.x).toBeGreaterThan(pos.D.x);
  });

  it("gives same-stage nodes distinct y positions", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    expect(pos.A.y).not.toBe(pos.B.y);
  });

  it("keeps every node to the right of all of its parents", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    for (const e of edges) expect(pos[e.to].x).toBeGreaterThan(pos[e.from].x);
  });

  it("centers narrow stages vertically against busiest stage", () => {
    const pos = computePositions(ids.map((id) => ({ id })), edges);
    expect(pos.E.y).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    const a = computePositions(ids.map((id) => ({ id })), edges);
    const b = computePositions(ids.map((id) => ({ id })), edges);
    expect(a).toEqual(b);
  });

  it("separates the multiplayer research fleet into readable non-overlapping stage columns", () => {
    const spec = JSON.parse(readFileSync(join(__dirname, "fixtures", "multiplayer-ai-fleet.json"), "utf-8"));
    const nodes = spec.workers.map((w: any) => ({ id: w.id, type: w.type, outputs: w.outputs, depends_on: w.depends_on }));
    const fleetEdges = spec.workers.flatMap((w: any) => w.depends_on.map((d: string) => ({ from: d, to: w.id })));
    const pos = computePositions(nodes, fleetEdges);
    for (const edge of fleetEdges) expect(pos[edge.to].x).toBeGreaterThan(pos[edge.from].x);
    const terminalIds = nodes.filter((n: any) => !fleetEdges.some((e: any) => e.from === n.id)).map((n: any) => n.id);
    const rightmostX = Math.max(...Object.values(pos).map((p) => p.x));
    for (const id of terminalIds) expect(pos[id].x, `${id} should be in the rightmost end stage`).toBe(rightmostX);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const overlapX = Math.abs(pos[a.id].x - pos[b.id].x) < 324;
        const overlapY = Math.abs(pos[a.id].y - pos[b.id].y) < Math.max(estimateNodeHeight(a), estimateNodeHeight(b)) + 28;
        expect(overlapX && overlapY, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });
});
