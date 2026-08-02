import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFleet } from "../src/scheduler.js";
import { resetForRelaunch } from "../src/state.js";
import type { FleetSpec, FleetState } from "../src/types.js";

async function root(spec: FleetSpec) {
  const r = await mkdtemp(join(tmpdir(), "fleet-sched-relaunch-"));
  for (const w of spec.workers) {
    await mkdir(join(r, "workers", w.id, "output"), { recursive: true });
  }
  return r;
}

function oneShotSpec(): FleetSpec {
  return {
    fleet_name: "oneshot",
    type: "dag",
    config: { max_concurrent: 2, model: "k2p6" },
    workers: [
      { id: "a", type: "code-run", task: "build", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }] },
      { id: "b", type: "code-run", task: "test", depends_on: ["a"], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      { id: "c", type: "code-run", task: "docs", depends_on: [], outputs: [{ path: "output/c.md", kind: "markdown", required: true }] },
    ],
  };
}

describe("runFleet relaunch", () => {
  it("continuePass one-shot resume reruns failed node and blocked dependents, not completed nodes", async () => {
    const spec = oneShotSpec();
    const fleetRoot = await root(spec);

    const counts: Record<string, number> = {};
    const first = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async (id) => {
        counts[id] = (counts[id] ?? 0) + 1;
        if (id === "a") {
          return { ok: false, turns: 1, tokens: 5, error: "fail" };
        }
        if (id === "c") {
          await writeFile(join(fleetRoot, "workers", "c", "output", "c.md"), "# C\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unexpected spawn ${id}`);
      },
    });

    expect(first.status).toBe("failed");
    expect(first.nodes.a.status).toBe("failed");
    expect(first.nodes.b.status).toBe("blocked");
    expect(first.nodes.c.status).toBe("completed");
    expect(counts).toEqual({ a: 1, c: 1 });

    const patched = resetForRelaunch(first, spec, "a");
    const second = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      resumeFrom: patched,
      continuePass: true,
      spawn: async (id) => {
        counts[id] = (counts[id] ?? 0) + 1;
        if (id === "a") {
          await writeFile(join(fleetRoot, "workers", "a", "output", "a.md"), "# A\n", "utf-8");
          return { ok: true, turns: 2, tokens: 10 };
        }
        if (id === "b") {
          await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# B\n", "utf-8");
          return { ok: true, turns: 1, tokens: 4 };
        }
        throw new Error(`should not respawn completed node ${id}`);
      },
    });

    expect(second.status).toBe("completed");
    expect(second.nodes.a.status).toBe("completed");
    expect(second.nodes.b.status).toBe("completed");
    expect(second.nodes.c.status).toBe("completed");
    expect(counts).toEqual({ a: 2, b: 1, c: 1 });
  });

  it("continuePass loop resume still runs boundary machinery and gate evaluation", async () => {
    const spec: FleetSpec = {
      fleet_name: "loop",
      type: "dag",
      config: {
        max_concurrent: 1,
        model: "k2p6",
        loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 1 },
      },
      workers: [
        { id: "b", type: "code-run", task: "build", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
        { id: "r", type: "reviewer", task: "review", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
      ],
    };
    const fleetRoot = await root(spec);

    const initial: FleetState = {
      fleet_name: spec.fleet_name,
      status: "failed",
      created_at: new Date().toISOString(),
      cost_usd_estimate: 0.3,
      nodes: {
        b: { status: "failed", turns: 1, tokens: 5, cost_usd_estimate: 0.1, produced_outputs: [] },
        r: { status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
      },
      iteration: 2,
      lgtm_streak: 0,
      paused: false,
      iterations: [
        {
          n: 1,
          verdict: "iterate",
          verdict_body: null,
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          nodes: {
            b: { status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.2, produced_outputs: ["output/b.md"] },
            r: { status: "completed", turns: 1, tokens: 3, cost_usd_estimate: 0.1, produced_outputs: ["output/review.md"], contract_result: { ok: true, checks: [], verdict: "iterate" } },
          },
        },
      ],
    };

    const patched = resetForRelaunch(initial, spec, "b");

    // Stale output proves resetForIteration/cleanReplayOutputs was skipped.
    await writeFile(join(fleetRoot, "workers", "b", "output", "stale.txt"), "stale", "utf-8");

    const prepared: number[] = [];
    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      resumeFrom: patched,
      continuePass: true,
      prepareIteration: async (n) => { prepared.push(n); },
      spawn: async (id) => {
        if (id === "b") {
          await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# Build\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "r") {
          await writeFile(join(fleetRoot, "workers", "r", "output", "review.md"), "verdict: lgtm\n\nlooks good", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unknown worker ${id}`);
      },
    });

    expect(final.status).toBe("completed");
    expect(final.iteration).toBe(2);
    expect(final.lgtm_streak).toBe(1);
    expect(final.iterations).toHaveLength(2);
    expect(final.iterations[1].n).toBe(2);
    expect(prepared).toEqual([2]);
    expect(final.nodes.b.status).toBe("completed");
    expect(final.nodes.r.status).toBe("completed");
    await expect(readFile(join(fleetRoot, "workers", "b", "output", "stale.txt"), "utf-8")).resolves.toBe("stale");
  });
});
