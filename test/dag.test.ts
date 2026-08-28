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

describe("effort validation", () => {
  it("accepts config.effort and worker effort", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      config: { effort: "high" },
      workers: [{ id: "a", type: "research", task: "t", effort: "low" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.config.effort).toBe("high");
      expect(r.spec.workers[0].effort).toBe("low");
    }
  });

  it("rejects bad config.effort", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      config: { effort: "ludicrous" },
      workers: [{ id: "a", type: "research", task: "t" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("config.effort");
  });

  it("rejects bad worker effort", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      workers: [{ id: "a", type: "research", task: "t", effort: "maxed" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain('worker "a": bad effort');
  });
});

describe("worktree validation", () => {
  it("auto-injects integrator for multiple worktrees", () => {
    const r = validateFleetSpec({
      fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.workers.some((w) => w.id === "fleet-integrator")).toBe(true);
      const integrator = r.spec.workers.find((w) => w.id === "fleet-integrator")!;
      expect(integrator.depends_on.sort()).toEqual(["a", "b"]);
    }
  });

  it("rejects an existing fleet-integrator that does not depend on all worktree workers", () => {
    const r = validateFleetSpec({
      fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
        { id: "fleet-integrator", type: "code-run", task: "partial merge", depends_on: ["a"], outputs: [] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("integrator"))).toBe(true);
  });

  it("auto-injects integrator when missing", () => {
    const r = validateFleetSpec({
      fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [], worktree: true },
        { id: "b", type: "code-run", task: "t", depends_on: ["a"], outputs: [], worktree: true },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.workers.some((w) => w.id === "fleet-integrator")).toBe(true);
      const integrator = r.spec.workers.find((w) => w.id === "fleet-integrator")!;
      expect(integrator.depends_on.sort()).toEqual(["a", "b"]);
    }
  });

  it("rejects overlapping repo-relative outputs without ordered handoff", () => {
    const r = validateFleetSpec({
      fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
        { id: "i", type: "code-run", task: "merge", depends_on: ["a", "b"], outputs: [] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("ownership conflict"))).toBe(true);
  });

  it("permits overlapping outputs with ordered handoff", () => {
    const r = validateFleetSpec({
      fleet_name: "wt", type: "dag", config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
        { id: "b", type: "code-run", task: "t", depends_on: ["a"], outputs: [{ path: "src/x.ts", kind: "file-exists", required: true }], worktree: true },
        { id: "i", type: "code-run", task: "merge", depends_on: ["b"], outputs: [] },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("repo output ownership", () => {
  const worker = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    type: "code-run",
    task: "t",
    depends_on: [],
    outputs: [],
    ...over,
  });
  const baseFleet = (workers: Record<string, unknown>[]) => ({
    fleet_name: "t-fleet",
    type: "dag",
    config: { max_concurrent: 2 },
    workers,
  });

  it("rejects overlapping repo-relative outputs without ordered handoff", () => {
    const fleet = baseFleet([
      worker("a", { outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
      worker("b", { outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
    ]);
    const v = validateFleetSpec(fleet);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toContain("repo output ownership conflict");
  });

  it("allows overlapping repo-relative output with ordered handoff", () => {
    const fleet = baseFleet([
      worker("a", { outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
      worker("b", { depends_on: ["a"], outputs: [{ path: "src/shared.ts", kind: "file-exists", required: true }] }),
    ]);
    const v = validateFleetSpec(fleet);
    expect(v.ok).toBe(true);
  });
});

describe("getDependents", () => {
  it("returns direct dependents", () => {
    const r = validateFleetSpec(base);
    if (!r.ok) throw new Error("unreachable");
    expect(getDependents(r.spec, "a").sort()).toEqual(["b", "c"]);
    expect(getDependents(r.spec, "d")).toEqual([]);
  });

  it("leaves config.model undefined when not provided", () => {
    const r = validateFleetSpec({
      fleet_name: "t", type: "dag",
      workers: [{ id: "a", type: "research", task: "t" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.config.model).toBeUndefined();
  });

  it("preserves max_cost_usd config", () => {
    const r = validateFleetSpec({
      ...base,
      config: { ...base.config, max_cost_usd: 9.99 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.config.max_cost_usd).toBe(9.99);
  });
});

