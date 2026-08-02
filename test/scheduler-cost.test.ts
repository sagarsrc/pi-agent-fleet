import { mkdtemp, mkdir } from "node:fs/promises";
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

async function root() {
  const r = await mkdtemp(join(tmpdir(), "fleet-sched-cost-"));
  await mkdir(join(r, "workers", "a", "output"), { recursive: true });
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
});
