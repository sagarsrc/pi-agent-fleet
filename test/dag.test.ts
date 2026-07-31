import { describe, expect, it } from "vitest";
import { getDependents, topoLayers, validateFleetSpec } from "../src/dag.js";

const base = {
  fleet_name: "t-fleet",
  type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "code-run", task: "t", depends_on: ["a"], outputs: [] },
    { id: "c", type: "reviewer", task: "t", depends_on: ["a"], outputs: [] },
    { id: "d", type: "write", task: "t", depends_on: ["b", "c"], outputs: [] },
  ],
};

describe("validateFleetSpec", () => {
  it("accepts a valid fleet and computes layers", () => {
    const r = validateFleetSpec(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layers).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("rejects unknown dependency", () => {
    const bad = structuredClone(base);
    bad.workers[1].depends_on = ["nope"];
    const r = validateFleetSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("nope");
  });
  it("rejects cycles with CYCLE: prefix", () => {
    const bad = structuredClone(base);
    bad.workers[0].depends_on = ["d"];
    const r = validateFleetSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/CYCLE:/);
  });
  it("rejects duplicate ids and bad worker id format", () => {
    const dup = structuredClone(base);
    dup.workers.push(dup.workers[0]);
    expect(validateFleetSpec(dup).ok).toBe(false);
    const badId = structuredClone(base);
    badId.workers[0].id = "Bad_Id";
    expect(validateFleetSpec(badId).ok).toBe(false);
  });
  it("applies defaults", () => {
    const min = { fleet_name: "f", type: "dag", config: {}, workers: [{ id: "a", type: "write", task: "t" }] };
    const r = validateFleetSpec(min);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.config.max_concurrent).toBe(4);
      expect(r.spec.workers[0].depends_on).toEqual([]);
      expect(r.spec.workers[0].outputs).toEqual([]);
    }
  });
  it("rejects absolute and parent-directory output paths", () => {
    const abs = structuredClone(base) as any;
    abs.workers[0].outputs = [{ path: "/etc/passwd", kind: "markdown", required: true }];
    expect(validateFleetSpec(abs).ok).toBe(false);
    const win = structuredClone(base) as any;
    win.workers[0].outputs = [{ path: "C:\\secret.txt", kind: "markdown", required: true }];
    expect(validateFleetSpec(win).ok).toBe(false);
    const dotdot = structuredClone(base) as any;
    dotdot.workers[0].outputs = [{ path: "../../etc/passwd", kind: "markdown", required: true }];
    expect(validateFleetSpec(dotdot).ok).toBe(false);
    const segmentDotDot = structuredClone(base) as any;
    segmentDotDot.workers[0].outputs = [{ path: "foo/../bar.md", kind: "markdown", required: true }];
    expect(validateFleetSpec(segmentDotDot).ok).toBe(false);
  });
});

describe("getDependents", () => {
  it("returns direct dependents", () => {
    const r = validateFleetSpec(base);
    if (!r.ok) throw new Error("unreachable");
    expect(getDependents(r.spec, "a").sort()).toEqual(["b", "c"]);
    expect(getDependents(r.spec, "d")).toEqual([]);
  });
});
