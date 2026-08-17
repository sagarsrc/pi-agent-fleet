import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runFleet } from "../src/scheduler.js";
import { relaunchResetIds, resetForRelaunch } from "../src/state.js";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("relaunchResetIds", () => {
  it("returns self plus transitively blocked dependents", () => {
    const spec: FleetSpec = {
      fleet_name: "graph",
      type: "dag",
      config: { max_concurrent: 1 },
      workers: [
        { id: "a", type: "write", task: "t", depends_on: [], outputs: [] },
        { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
        { id: "c", type: "write", task: "t", depends_on: ["b"], outputs: [] },
        { id: "d", type: "write", task: "t", depends_on: [], outputs: [] },
      ],
    };
    const state: FleetState = {
      fleet_name: spec.fleet_name,
      status: "failed",
      created_at: new Date().toISOString(),
      cost_usd_estimate: 0,
      nodes: {
        a: { status: "failed", turns: 1, tokens: 5, cost_usd_estimate: 0, produced_outputs: [] },
        b: { status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
        c: { status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
        d: { status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0, produced_outputs: [] },
      },
      iteration: 1,
      lgtm_streak: 0,
      paused: false,
      iterations: [],
    };

    expect(relaunchResetIds(spec, state, "a")).toEqual(["a", "b", "c"]);
  });
});

describe("runFleet relaunch", () => {
  it("re-dispatches a contract_failed node queued via relaunchRequests mid-run", async () => {
    const spec: FleetSpec = {
      fleet_name: "mid-run-contract",
      type: "dag",
      config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "write", task: "t", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }] },
        { id: "slow", type: "write", task: "t", depends_on: [], outputs: [] },
      ],
    };
    const fleetRoot = await root(spec);
    const counts: Record<string, number> = {};
    const relaunchRequests = new Set<string>();
    const slow = deferred();
    let queued = false;

    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      relaunchRequests,
      onNodeChange: (id, s) => {
        if (id === "a" && s.status === "contract_failed" && !queued) {
          queued = true;
          relaunchRequests.add("a");
          slow.resolve();
        }
      },
      spawn: async (id) => {
        counts[id] = (counts[id] ?? 0) + 1;
        if (id === "a") {
          if (counts[id] === 1) return { ok: true, turns: 1, tokens: 5 };
          await writeFile(join(fleetRoot, "workers", "a", "output", "a.md"), "# A\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "slow") {
          await slow.promise;
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unexpected spawn ${id}`);
      },
    });

    expect(queued).toBe(true);
    expect(counts).toEqual({ a: 2, slow: 1 });
    expect(final.status).toBe("completed");
    expect(final.nodes.a.status).toBe("completed");
    expect(final.nodes.slow.status).toBe("completed");
  });

  it("drains relaunch requests queued while scheduler was winding down", async () => {
    const spec: FleetSpec = {
      fleet_name: "wind-down-contract",
      type: "dag",
      config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "write", task: "t", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }] },
        { id: "b", type: "write", task: "t", depends_on: [], outputs: [] },
      ],
    };
    const fleetRoot = await root(spec);
    const counts: Record<string, number> = {};
    const relaunchRequests = new Set<string>();
    const slow = deferred();
    let aContractFailed = false;
    let bCompleted = false;
    let queued = false;
    let resolveQueued = () => {};
    const queuedPromise = new Promise<void>((resolve) => {
      resolveQueued = resolve;
    });

    const originalAllSettled = Promise.allSettled.bind(Promise);
    const allSettledSpy = vi.spyOn(Promise, "allSettled").mockImplementation(async (values) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return originalAllSettled(values);
    });

    let final!: FleetState;
    try {
      const finalPromise = runFleet({
        spec,
        fleetRoot,
        repoCwd: "/tmp",
        relaunchRequests,
        onNodeChange: (id, s) => {
          if (id === "a" && s.status === "contract_failed" && !aContractFailed) {
            aContractFailed = true;
            slow.resolve();
          }
          if (id === "b" && s.status === "completed" && aContractFailed && !queued) {
            bCompleted = true;
            setImmediate(() => {
              queued = true;
              relaunchRequests.add("a");
              resolveQueued();
            });
          }
        },
        spawn: async (id) => {
          counts[id] = (counts[id] ?? 0) + 1;
          if (id === "a") {
            if (counts[id] === 1) return { ok: true, turns: 1, tokens: 5 };
            await writeFile(join(fleetRoot, "workers", "a", "output", "a.md"), "# A\n", "utf-8");
            return { ok: true, turns: 1, tokens: 5 };
          }
          if (id === "b") {
            await slow.promise;
            return { ok: true, turns: 1, tokens: 5 };
          }
          throw new Error(`unexpected spawn ${id}`);
        },
      });

      await queuedPromise;
      final = await finalPromise;
    } finally {
      allSettledSpy.mockRestore();
    }

    expect(aContractFailed).toBe(true);
    expect(bCompleted).toBe(true);
    expect(queued).toBe(true);
    expect(counts).toEqual({ a: 2, b: 1 });
    expect(final.status).toBe("completed");
    expect(final.nodes.a.status).toBe("completed");
    expect(final.nodes.b.status).toBe("completed");
  });

  it("relaunch of a failed upstream resets blocked downstream to pending", async () => {
    const spec: FleetSpec = {
      fleet_name: "mid-run-upstream",
      type: "dag",
      config: { max_concurrent: 2 },
      workers: [
        { id: "root", type: "write", task: "t", depends_on: [], outputs: [{ path: "output/root.md", kind: "markdown", required: true }] },
        { id: "mid", type: "write", task: "t", depends_on: ["root"], outputs: [{ path: "output/mid.md", kind: "markdown", required: true }] },
        { id: "slow", type: "write", task: "t", depends_on: [], outputs: [] },
      ],
    };
    const fleetRoot = await root(spec);
    const counts: Record<string, number> = {};
    const relaunchRequests = new Set<string>();
    const slow = deferred();
    let queued = false;

    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      relaunchRequests,
      onNodeChange: (id, s) => {
        if (id === "root" && s.status === "failed") slow.resolve();
        if (id === "mid" && s.status === "blocked" && !queued) {
          queued = true;
          relaunchRequests.add("root");
        }
      },
      spawn: async (id) => {
        counts[id] = (counts[id] ?? 0) + 1;
        if (id === "root") {
          if (counts[id] === 1) return { ok: false, turns: 1, tokens: 5, error: "fail" };
          await writeFile(join(fleetRoot, "workers", "root", "output", "root.md"), "# root\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "mid") {
          await writeFile(join(fleetRoot, "workers", "mid", "output", "mid.md"), "# mid\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "slow") {
          await slow.promise;
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unexpected spawn ${id}`);
      },
    });

    expect(queued).toBe(true);
    expect(counts).toEqual({ root: 2, slow: 1, mid: 1 });
    expect(final.status).toBe("completed");
    expect(final.nodes.root.status).toBe("completed");
    expect(final.nodes.mid.status).toBe("completed");
    expect(final.nodes.slow.status).toBe("completed");
  });

  it("ignores relaunchRequests for nodes that are running or completed", async () => {
    const spec: FleetSpec = {
      fleet_name: "mid-run-ignore",
      type: "dag",
      config: { max_concurrent: 2 },
      workers: [
        { id: "a", type: "write", task: "t", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }] },
        { id: "slow", type: "write", task: "t", depends_on: [], outputs: [] },
      ],
    };
    const fleetRoot = await root(spec);
    const counts: Record<string, number> = {};
    const relaunchRequests = new Set<string>();
    const slow = deferred();

    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      relaunchRequests,
      onNodeChange: (id, s) => {
        if (id === "a" && s.status === "running") relaunchRequests.add("a");
        if (id === "a" && s.status === "completed") {
          relaunchRequests.add("a");
          slow.resolve();
        }
      },
      spawn: async (id) => {
        counts[id] = (counts[id] ?? 0) + 1;
        if (id === "a") {
          await writeFile(join(fleetRoot, "workers", "a", "output", "a.md"), "# A\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "slow") {
          await slow.promise;
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unexpected spawn ${id}`);
      },
    });

    expect(counts).toEqual({ a: 1, slow: 1 });
    expect(final.status).toBe("completed");
    expect(final.nodes.a.status).toBe("completed");
    expect(final.nodes.slow.status).toBe("completed");
  });

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

  it("relaunch with a stale killed switch kills reset nodes", async () => {
    const spec = oneShotSpec();
    const fleetRoot = await root(spec);
    const initial: FleetState = {
      fleet_name: spec.fleet_name,
      status: "failed",
      created_at: new Date().toISOString(),
      cost_usd_estimate: 0,
      nodes: {
        a: { status: "failed", turns: 1, tokens: 5, cost_usd_estimate: 0, produced_outputs: [] },
        b: { status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
        c: { status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.05, produced_outputs: ["output/c.md"] },
      },
      iteration: 1,
      lgtm_streak: 0,
      paused: false,
      iterations: [],
    };

    const patched = resetForRelaunch(initial, spec, "a");
    const staleKillSwitch = { killed: true };
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      resumeFrom: patched,
      continuePass: true,
      killSwitch: staleKillSwitch,
      spawn: async () => ({ ok: true, turns: 1, tokens: 5 }),
    });

    expect(s.status).toBe("killed");
    expect(s.nodes.a.status).toBe("killed");
    expect(s.nodes.b.status).toBe("killed");
    expect(s.nodes.c.status).toBe("completed");
  });

  it("relaunch succeeds when killed switch is cleared", async () => {
    const spec = oneShotSpec();
    const fleetRoot = await root(spec);
    const initial: FleetState = {
      fleet_name: spec.fleet_name,
      status: "failed",
      created_at: new Date().toISOString(),
      cost_usd_estimate: 0,
      nodes: {
        a: { status: "failed", turns: 1, tokens: 5, cost_usd_estimate: 0, produced_outputs: [] },
        b: { status: "blocked", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
        c: { status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.05, produced_outputs: ["output/c.md"] },
      },
      iteration: 1,
      lgtm_streak: 0,
      paused: false,
      iterations: [],
    };

    const patched = resetForRelaunch(initial, spec, "a");
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      resumeFrom: patched,
      continuePass: true,
      killSwitch: { killed: false },
      spawn: async (id) => {
        if (id === "a") await writeFile(join(fleetRoot, "workers", "a", "output", "a.md"), "# A\n", "utf-8");
        if (id === "b") await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# B\n", "utf-8");
        return { ok: true, turns: 1, tokens: 5 };
      },
    });

    expect(s.status).toBe("completed");
    expect(s.nodes.a.status).toBe("completed");
    expect(s.nodes.b.status).toBe("completed");
    expect(s.nodes.c.status).toBe("completed");
  });
});
