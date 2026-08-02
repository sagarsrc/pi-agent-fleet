import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFleet } from "../src/scheduler.js";
import type { FleetSpec, FleetState, IterationSnapshot } from "../src/types.js";

function baseSpec(over: Partial<FleetSpec> = {}): FleetSpec {
  return {
    fleet_name: "loop",
    type: "dag",
    config: {
      max_concurrent: 1,
      model: "k2p6",
      loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 2 },
      ...(over.config ?? {}),
    },
    workers: over.workers ?? [
      { id: "b", type: "code-run", task: "build", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      { id: "r", type: "reviewer", task: "review", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
    ],
  };
}

async function makeRoot(spec: FleetSpec) {
  const r = await mkdtemp(join(tmpdir(), "fleet-sched-loop-"));
  for (const w of spec.workers) {
    await mkdir(join(r, "workers", w.id, "output"), { recursive: true });
  }
  return r;
}

function makeSpawn(fleetRoot: string, verdicts: string[]) {
  return async (id: string) => {
    if (id === "b") {
      await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# Build\n", "utf-8");
      return { ok: true, turns: 1, tokens: 5 };
    }
    if (id === "r") {
      const v = verdicts.shift();
      if (!v) return { ok: true, turns: 1, tokens: 5 };
      await writeFile(join(fleetRoot, "workers", "r", "output", "review.md"), `verdict: ${v}\n\nbody ${v}`, "utf-8");
      return { ok: true, turns: 1, tokens: 5 };
    }
    if (id === "once") {
      await writeFile(join(fleetRoot, "workers", "once", "output", "once.md"), "# Once\n", "utf-8");
      return { ok: true, turns: 1, tokens: 5 };
    }
    throw new Error(`unknown worker ${id}`);
  };
}

describe("runFleet loop", () => {
  it("lgtm streak reaches lgtm_count -> completed", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: makeSpawn(fleetRoot, ["lgtm", "lgtm"]) });
    expect(s.status).toBe("completed");
    expect(s.lgtm_streak).toBe(2);
    expect(s.iterations).toHaveLength(2);
  });

  it("iterate resets streak", async () => {
    const spec = baseSpec({ config: { max_concurrent: 1, model: "k2p6", loop: { gate: "reviewer", max_iterations: 4, lgtm_count: 2 } } });
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: makeSpawn(fleetRoot, ["lgtm", "iterate", "lgtm", "lgtm"]) });
    expect(s.status).toBe("completed");
    expect(s.lgtm_streak).toBe(2);
    expect(s.iterations).toHaveLength(4);
  });

  it("escalate -> paused, streak preserved", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: makeSpawn(fleetRoot, ["lgtm", "escalate"]) });
    expect(s.status).toBe("paused");
    expect(s.paused).toBe(true);
    expect(s.lgtm_streak).toBe(1);
    expect(s.iterations).toHaveLength(2);
    expect(s.iterations[1].verdict).toBe("escalate");
  });

  it("max_iterations exhausted -> failed", async () => {
    const spec = baseSpec({ config: { max_concurrent: 1, model: "k2p6", loop: { gate: "reviewer", max_iterations: 2, lgtm_count: 2 } } });
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: makeSpawn(fleetRoot, ["iterate", "iterate"]) });
    expect(s.status).toBe("failed");
    expect(s.iterations).toHaveLength(2);
  });

  it("run-once node not re-run across iterations", async () => {
    const spec = baseSpec({
      workers: [
        { id: "once", type: "code-run", task: "once", depends_on: [], outputs: [{ path: "output/once.md", kind: "markdown", required: true }], iterate: false },
        { id: "b", type: "code-run", task: "build", depends_on: ["once"], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
        { id: "r", type: "reviewer", task: "review", depends_on: ["b"], outputs: [{ path: "output/review.md", kind: "verdict", required: true }] },
      ],
    });
    const fleetRoot = await makeRoot(spec);
    const counts: Record<string, number> = {};
    const spawn = makeSpawn(fleetRoot, ["lgtm", "lgtm"]);
    const tracked = async (id: string) => {
      counts[id] = (counts[id] ?? 0) + 1;
      return spawn(id);
    };
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: tracked });
    expect(s.status).toBe("completed");
    expect(s.iterations).toHaveLength(2);
    expect(counts.once).toBe(1);
    expect(counts.b).toBe(2);
    expect(counts.r).toBe(2);
  });

  it("pauseSwitch at boundary -> paused", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const pauseSwitch = { paused: false };
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: makeSpawn(fleetRoot, ["lgtm", "lgtm"]),
      pauseSwitch,
      onIterationEnd: () => { pauseSwitch.paused = true; },
    });
    expect(s.status).toBe("paused");
    expect(s.paused).toBe(true);
    expect(s.iterations).toHaveLength(1);
  });

  it("kill mid-iteration archives partial snapshot and ends killed", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const killSwitch = { killed: false };
    const spawn = makeSpawn(fleetRoot, ["lgtm", "lgtm"]);
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "b") await new Promise((r) => setTimeout(r, 30));
        return spawn(id);
      },
      killSwitch,
      prepareIteration: async (n) => {
        if (n === 2) setTimeout(() => { killSwitch.killed = true; }, 10);
      },
    });
    expect(s.status).toBe("killed");
    expect(s.iterations).toHaveLength(2);
    expect(s.iterations[1].nodes.b.status).toBe("killed");
  });

  it("reviewer contract_failed -> fleet failed", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: makeSpawn(fleetRoot, []) });
    expect(s.status).toBe("failed");
    expect(s.nodes.r.status).toBe("contract_failed");
    expect(s.iterations).toHaveLength(1);
    expect(s.iterations[0].verdict).toBeNull();
  });

  it("gate none loops until max_iterations then failed", async () => {
    const spec = baseSpec({
      config: { max_concurrent: 1, model: "k2p6", loop: { gate: "none", max_iterations: 2, lgtm_count: 1 } },
      workers: [{ id: "b", type: "code-run", task: "build", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] }],
    });
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({ spec, fleetRoot, repoCwd: "/tmp", spawn: makeSpawn(fleetRoot, []) });
    expect(s.status).toBe("failed");
    expect(s.iterations).toHaveLength(2);
    expect(s.iterations.every((it) => it.verdict === null)).toBe(true);
  });

  it("no loop config -> single pass, no snapshots", async () => {
    const spec = baseSpec({
      config: { max_concurrent: 1, model: "k2p6", loop: undefined },
      workers: [{ id: "b", type: "code-run", task: "build", depends_on: [], outputs: [] }],
    });
    const fleetRoot = await makeRoot(spec);
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 5 }),
    });
    expect(s.status).toBe("completed");
    expect(s.iteration).toBe(1);
    expect(s.iterations).toHaveLength(0);
  });

  it("repoCwd function resolves per node", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const seen: string[] = [];
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: (id) => { seen.push(id); return "/tmp"; },
      spawn: makeSpawn(fleetRoot, ["lgtm", "lgtm"]),
    });
    expect(s.status).toBe("completed");
    expect(seen.sort()).toEqual(["b", "b", "r", "r"]);
  });

  it("prepareIteration is called before each pass", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const prepared: Array<{ n: number; iteration: number }> = [];
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: makeSpawn(fleetRoot, ["lgtm", "lgtm"]),
      prepareIteration: async (n, st) => { prepared.push({ n, iteration: st.iteration }); },
    });
    expect(s.status).toBe("completed");
    expect(prepared).toEqual([{ n: 1, iteration: 1 }, { n: 2, iteration: 2 }]);
  });

  it("onIterationEnd receives snapshots", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const snaps: IterationSnapshot[] = [];
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: makeSpawn(fleetRoot, ["lgtm", "lgtm"]),
      onIterationEnd: (snap) => { snaps.push(snap); },
    });
    expect(s.status).toBe("completed");
    expect(snaps).toHaveLength(2);
    expect(snaps[0].n).toBe(1);
    expect(snaps[1].n).toBe(2);
  });

  it("cleans replay node output dirs between iterations", async () => {
    const spec = baseSpec({
      config: { max_concurrent: 1, model: "k2p6", loop: { gate: "none", max_iterations: 2, lgtm_count: 1 } },
      workers: [{ id: "b", type: "code-run", task: "build", depends_on: [], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] }],
    });
    const fleetRoot = await makeRoot(spec);
    let calls = 0;
    const s = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async (id) => {
        calls++;
        if (id === "b" && calls === 1) {
          await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# Build\n", "utf-8");
        }
        return { ok: true, turns: 1, tokens: 5 };
      },
    });
    expect(s.status).toBe("failed");
    expect(s.nodes.b.status).toBe("contract_failed");
  });

  it("cleans replay node output dirs on resume after escalate", async () => {
    const spec = baseSpec({
      config: { max_concurrent: 1, model: "k2p6", loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 1 } },
    });
    const fleetRoot = await makeRoot(spec);

    const first = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "b") {
          await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# Build\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "r") {
          await writeFile(join(fleetRoot, "workers", "r", "output", "review.md"), "verdict: escalate\n\nescalating", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unknown worker ${id}`);
      },
    });
    expect(first.status).toBe("paused");

    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      resumeFrom: first,
      spawn: async (id) => {
        if (id === "b") return { ok: true, turns: 1, tokens: 5 }; // writes nothing
        if (id === "r") return { ok: true, turns: 1, tokens: 5 };
        throw new Error(`unknown worker ${id}`);
      },
    });
    expect(final.status).toBe("failed");
    expect(final.nodes.b.status).toBe("contract_failed");
  });

  it("resumeFrom after escalate continues with monotonic snapshots and no archive collisions", async () => {
    const spec = baseSpec({
      config: { max_concurrent: 1, model: "k2p6", loop: { gate: "reviewer", max_iterations: 4, lgtm_count: 2 } },
    });
    const fleetRoot = await makeRoot(spec);

    const first = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: makeSpawn(fleetRoot, ["iterate", "escalate"]),
    });
    expect(first.status).toBe("paused");
    expect(first.paused).toBe(true);
    expect(first.iterations.map((it) => it.n)).toEqual([1, 2]);

    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: makeSpawn(fleetRoot, ["lgtm", "lgtm"]),
      resumeFrom: first,
    });

    expect(final.status).toBe("completed");
    expect(final.lgtm_streak).toBe(2);
    expect(final.iterations.map((it) => it.n)).toEqual([1, 2, 3, 4]);
    expect(final.iterations.length).toBe(new Set(final.iterations.map((it) => it.n)).size);

    for (const it of final.iterations) {
      await stat(join(fleetRoot, "iterations", String(it.n), "workers", "b", "output", "b.md"));
    }
  });

  it("resumeFrom clears paused state and proceeds when pauseSwitch is false", async () => {
    const spec = baseSpec();
    const fleetRoot = await makeRoot(spec);
    const snap: IterationSnapshot = {
      n: 1,
      verdict: "lgtm",
      verdict_body: "ok",
      started_at: new Date(Date.now() - 1000).toISOString(),
      ended_at: new Date().toISOString(),
      nodes: {
        b: { status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.05, produced_outputs: ["output/b.md"] },
        r: { status: "completed", turns: 1, tokens: 5, cost_usd_estimate: 0.05, produced_outputs: ["output/review.md"], contract_result: { ok: true, checks: [], verdict: "lgtm" } },
      },
    };
    const initial: FleetState = {
      fleet_name: spec.fleet_name,
      status: "paused",
      created_at: new Date().toISOString(),
      cost_usd_estimate: 0.1,
      nodes: snap.nodes,
      iteration: 2,
      lgtm_streak: 1,
      paused: true,
      iterations: [snap],
    };

    const final = await runFleet({
      spec,
      fleetRoot,
      repoCwd: "/tmp",
      resumeFrom: initial,
      pauseSwitch: { paused: false },
      spawn: async (id) => {
        if (id === "b") {
          await writeFile(join(fleetRoot, "workers", "b", "output", "b.md"), "# Build\n", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        if (id === "r") {
          await writeFile(join(fleetRoot, "workers", "r", "output", "review.md"), "verdict: lgtm\n\nbody", "utf-8");
          return { ok: true, turns: 1, tokens: 5 };
        }
        throw new Error(`unknown worker ${id}`);
      },
    });

    expect(final.status).toBe("completed");
    expect(final.paused).toBe(false);
    expect(final.iteration).toBe(3);
    expect(final.lgtm_streak).toBe(2);
  });
});
