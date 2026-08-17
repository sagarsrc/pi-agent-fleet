import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFleet } from "../src/scheduler.js";
import type { FleetSpec } from "../src/types.js";

function spec(): FleetSpec {
  return {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1, model: "k2p6" },
    workers: [
      { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    ],
  };
}

async function root(spec?: FleetSpec) {
  const r = await mkdtemp(join(tmpdir(), "fleet-sched-cost-"));
  for (const w of spec?.workers ?? [{ id: "a" }]) {
    await mkdir(join(r, "workers", w.id, "output"), { recursive: true });
  }
  return r;
}

describe("runFleet cost", () => {
  it("patches cost_usd_estimate from spawn result", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 10, cost: 0.03 }),
    });
    expect(s.nodes.a.cost_usd_estimate).toBe(0.03);
    expect(s.cost_usd_estimate).toBe(0.03);
  });

  it("patches cost even on spawn failure", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: false, turns: 1, tokens: 5, error: "x", cost: 0.01 }),
    });
    expect(s.nodes.a.status).toBe("failed");
    expect(s.nodes.a.cost_usd_estimate).toBe(0.01);
  });

  it("notes when tokens were consumed but cost stayed zero (unknown pricing)", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 2, tokens: 44000, cost: 0 }),
    });
    expect(s.nodes.a.status_note).toMatch(/cost .*unavailable|no pricing/i);
  });

  it("adds no note when cost is positive", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 2, tokens: 44000, cost: 0.5 }),
    });
    expect(s.nodes.a.status_note).toBeUndefined();
  });

  it("adds no note when tokens are zero", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 2, tokens: 0, cost: 0 }),
    });
    expect(s.nodes.a.status_note).toBeUndefined();
  });

  it("loop with run-once node counts its cost exactly once", async () => {
    const loopSpec: FleetSpec = {
      fleet_name: "loop-once",
      type: "dag",
      config: { max_concurrent: 1, model: "k2p6", loop: { gate: "none", max_iterations: 2, lgtm_count: 1 } },
      workers: [
        { id: "once", type: "code-run", task: "once", depends_on: [], outputs: [{ path: "output/once.md", kind: "markdown", required: true }], iterate: false },
        { id: "b", type: "code-run", task: "build", depends_on: ["once"], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      ],
    };
    const fleetRoot = await root(loopSpec);
    const s = await runFleet({
      spec: loopSpec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "once") {
          await writeFile(join(fleetRoot, "workers", "once", "output", "once.md"), "# Once\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5, cost: 0.1 };
        }
        await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# Build\n", "utf-8");
        return { ok: true, turns: 1, tokens: 5, cost: 0.05 };
      },
    });
    expect(s.iterations).toHaveLength(2);
    expect(s.iterations[0].nodes.once.cost_usd_estimate).toBe(0.1);
    expect(s.iterations[0].nodes.b.cost_usd_estimate).toBe(0.05);
    expect(s.iterations[1].nodes.once.cost_usd_estimate).toBe(0);
    expect(s.iterations[1].nodes.b.cost_usd_estimate).toBe(0.05);
    expect(s.cost_usd_estimate).toBeCloseTo(0.2, 6);
  });
});
