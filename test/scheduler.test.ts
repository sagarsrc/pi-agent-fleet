import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFleet } from "../src/scheduler.js";
import type { FleetSpec } from "../src/types.js";

function spec(): FleetSpec {
  return {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 2, model: "k2p6" },
    workers: [
      { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
      { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
    ],
  };
}

async function root() {
  const r = await mkdtemp(join(tmpdir(), "fleet-sched-"));
  await mkdir(join(r, "workers", "a", "output"), { recursive: true });
  await mkdir(join(r, "workers", "b", "output"), { recursive: true });
  return r;
}

describe("runFleet", () => {
  it("runs deps in order, completes", async () => {
    const order: string[] = [];
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => { order.push(id); return { ok: true, turns: 1, tokens: 10 }; },
    });
    expect(order).toEqual(["a", "b"]);
    expect(s.status).toBe("completed");
    expect(s.nodes.a.status).toBe("completed");
    expect(s.cost_usd_estimate).toBeGreaterThanOrEqual(0);
  });
  it("blocks dependents of failed nodes", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => (id === "a" ? { ok: false, turns: 1, tokens: 5, error: "x" } : { ok: true, turns: 1, tokens: 5 }),
    });
    expect(s.nodes.a.status).toBe("failed");
    expect(s.nodes.b.status).toBe("blocked");
    expect(s.status).toBe("failed");
  });
  it("marks contract_failed when required output missing", async () => {
    const sp = spec();
    sp.workers[0].outputs = [{ path: "output/findings.md", kind: "markdown", required: true }];
    const s = await runFleet({
      spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 5 }), // writes nothing
    });
    expect(s.nodes.a.status).toBe("contract_failed");
    expect(s.nodes.a.contract_result?.ok).toBe(false);
    expect(s.nodes.b.status).toBe("blocked");
  });
  it("passes contract when worker wrote the file", async () => {
    const sp = spec();
    sp.workers[0].outputs = [{ path: "output/findings.md", kind: "markdown", required: true }];
    const fleetRoot = await root();
    const s = await runFleet({
      spec: sp, fleetRoot, repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "a") await writeFile(join(fleetRoot, "workers", "a", "output", "findings.md"), "# F\nbody");
        return { ok: true, turns: 1, tokens: 5 };
      },
    });
    expect(s.nodes.a.status).toBe("completed");
    expect(s.nodes.b.status).toBe("completed");
  });
});
