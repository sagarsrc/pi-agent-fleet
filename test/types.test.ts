import { describe, expect, it } from "vitest";
import { TERMINAL_NODE_STATUSES, WORKER_TYPE_TOOLS } from "../src/types.js";
import type { FleetSpec, IterationSnapshot, LoopConfig } from "../src/types.js";

describe("types", () => {
  it("terminal statuses match ontology", () => {
    expect([...TERMINAL_NODE_STATUSES].sort()).toEqual(
      ["blocked", "completed", "contract_failed", "failed", "killed"],
    );
  });

  it("every worker type has a tool allowlist", () => {
    for (const t of ["research", "code-run", "reviewer", "write", "read-only"] as const) {
      expect(WORKER_TYPE_TOOLS[t].length).toBeGreaterThan(0);
    }
    expect(WORKER_TYPE_TOOLS["read-only"]).not.toContain("write");
    expect(WORKER_TYPE_TOOLS.research).toContain("web_search");
  });
});

describe("loop fleet types", () => {
  it("LoopConfig accepts reviewer gate", () => {
    const loop: LoopConfig = { gate: "reviewer", max_iterations: 5, lgtm_count: 2 };
    expect(loop.lgtm_count).toBe(2);
  });

  it("FleetSpec carries loop config and per-node flags", () => {
    const spec: FleetSpec = {
      fleet_name: "t",
      type: "dag",
      config: { max_concurrent: 1, model: "m", loop: { gate: "none", max_iterations: 3, lgtm_count: 1 } },
      workers: [{ id: "a", type: "write", task: "t", depends_on: [], outputs: [], iterate: true, worktree: false }],
    };
    expect(spec.config.loop?.gate).toBe("none");
    expect(spec.workers[0].iterate).toBe(true);
  });

  it("IterationSnapshot shape", () => {
    const snap: IterationSnapshot = {
      n: 1,
      verdict: "iterate",
      verdict_body: "fix x",
      started_at: "s",
      ended_at: "e",
      nodes: {},
    };
    expect(snap.verdict).toBe("iterate");
  });

  it("paused is not terminal node status concept — fleet status only", () => {
    expect(TERMINAL_NODE_STATUSES.has("killed")).toBe(true);
  });
});
