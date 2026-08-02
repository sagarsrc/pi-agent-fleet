import { describe, expect, it } from "vitest";
import { initFleetState, resetForRelaunch } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t",
  type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [
    { id: "a", type: "write", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
    { id: "c", type: "write", task: "t", depends_on: ["b"], outputs: [] },
    { id: "d", type: "write", task: "t", depends_on: [], outputs: [] },
  ],
};

const fresh = { status: "pending" as const, turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] };

describe("resetForRelaunch", () => {
  it("resets target failed node and blocked dependents to pending, leaves others untouched", () => {
    const s = initFleetState(spec);
    s.paused = true;
    s.status = "failed";
    s.nodes = {
      ...s.nodes,
      a: { ...s.nodes.a, status: "failed", turns: 3, tokens: 30, cost_usd_estimate: 0.1, status_note: "boom" },
      b: { ...s.nodes.b, status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0.05, produced_outputs: [] },
      c: { ...s.nodes.c, status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0.02 },
      d: { ...s.nodes.d, status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.4, produced_outputs: ["x"] },
    };

    const r = resetForRelaunch(s, spec, "a");

    expect(r.nodes.a).toEqual(fresh);
    expect(r.nodes.b).toEqual(fresh);
    expect(r.nodes.c).toEqual(fresh);
    expect(r.nodes.d).toEqual({ ...s.nodes.d });
    expect(r.paused).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.cost_usd_estimate).toBeCloseTo(0.4, 6);
  });

  it("does not reset dependents that are completed or failed", () => {
    const s = initFleetState(spec);
    s.status = "failed";
    s.nodes = {
      ...s.nodes,
      a: { ...s.nodes.a, status: "killed", turns: 1, tokens: 10, cost_usd_estimate: 0.1 },
      b: { ...s.nodes.b, status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.2, produced_outputs: ["b.md"] },
      c: { ...s.nodes.c, status: "failed", turns: 1, tokens: 4, cost_usd_estimate: 0.05 },
    };

    const r = resetForRelaunch(s, spec, "a");

    expect(r.nodes.a).toEqual(fresh);
    expect(r.nodes.b).toEqual({ ...s.nodes.b });
    expect(r.nodes.c).toEqual({ ...s.nodes.c });
  });

  it("resets transitively blocked dependents", () => {
    const s = initFleetState(spec);
    s.status = "failed";
    s.nodes = {
      ...s.nodes,
      a: { ...s.nodes.a, status: "contract_failed", turns: 2, tokens: 20, cost_usd_estimate: 0.1 },
      b: { ...s.nodes.b, status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0.05 },
      c: { ...s.nodes.c, status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0.03 },
    };

    const r = resetForRelaunch(s, spec, "a");

    expect(r.nodes.a).toEqual(fresh);
    expect(r.nodes.b).toEqual(fresh);
    expect(r.nodes.c).toEqual(fresh);
  });

  it("throws for unknown node id", () => {
    const s = initFleetState(spec);
    expect(() => resetForRelaunch(s, spec, "z")).toThrow('unknown node "z"');
  });
});
