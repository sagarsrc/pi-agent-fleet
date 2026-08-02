import { describe, expect, it } from "vitest";
import { validateFleetSpec } from "../src/dag.js";

function baseSpec(over: Record<string, unknown> = {}) {
  return {
    fleet_name: "t",
    type: "dag",
    config: { max_concurrent: 1, model: "m", ...(over.config as object ?? {}) },
    workers: over.workers ?? [
      { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      { id: "r", type: "reviewer", task: "t", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
    ],
  };
}

describe("loop validation", () => {
  it("(a) valid reviewer gate gets defaults", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } } }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.spec.config.loop?.lgtm_count).toBe(1);
      expect(v.spec.workers.every((w) => w.iterate === true && w.worktree === false)).toBe(true);
    }
  });

  it("(b) rejects max_iterations 0", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 0 } } }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/max_iterations/);
  });

  it("(c) rejects loop without gate", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { max_iterations: 3 } } }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/gate/);
  });

  it("(d) rejects lgtm_count with gate none", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "none", max_iterations: 3, lgtm_count: 2 } } }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/lgtm_count/);
  });

  it("(e) rejects two verdict nodes", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "verdict", required: true }] },
        { id: "r", type: "reviewer", task: "t", depends_on: [], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
      ],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/verdict/);
  });

  it("(f) rejects verdict node with dependent", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
        { id: "r", type: "reviewer", task: "t", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
        { id: "c", type: "code-run", task: "t", depends_on: ["r"], outputs: [] },
      ],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/verdict/);
  });

  it("(g) rejects verdict node with iterate false", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
        { id: "r", type: "reviewer", task: "t", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }], iterate: false },
      ],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/verdict/);
  });

  it("(h) rejects run-once depending on replay", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
        { id: "r", type: "reviewer", task: "t", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
        { id: "c", type: "code-run", task: "t", depends_on: ["b"], outputs: [], iterate: false },
      ],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/run-once/);
  });

  it("(i) allows replay depending on run-once", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }], iterate: false },
        { id: "r", type: "reviewer", task: "t", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
      ],
    }));
    expect(v.ok).toBe(true);
  });

  it("(j) gate none valid spec passes", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "none", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      ],
    }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.spec.workers.every((w) => w.iterate === true && w.worktree === false)).toBe(true);
  });

  it("(k) no loop still applies defaults", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m" },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      ],
    }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.spec.config.loop).toBeUndefined();
      expect(v.spec.workers.every((w) => w.iterate === true && w.worktree === false)).toBe(true);
    }
  });

  it("rejects lgtm_count greater than max_iterations", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 2, lgtm_count: 3 } } }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/lgtm_count must be <= max_iterations/);
  });

  it("allows lgtm_count equal to max_iterations", () => {
    const v = validateFleetSpec(baseSpec({ config: { max_concurrent: 1, model: "m", loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 3 } } }));
    expect(v.ok).toBe(true);
  });

  it("rejects gate none with all run-once nodes", () => {
    const v = validateFleetSpec(baseSpec({
      config: { max_concurrent: 1, model: "m", loop: { gate: "none", max_iterations: 3 } },
      workers: [
        { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }], iterate: false },
      ],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join("\n")).toMatch(/gate none requires at least one replay node/);
  });
});
