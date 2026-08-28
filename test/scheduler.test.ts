import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runFleet } from "../src/scheduler.js";
import { patchNode, initFleetState } from "../src/state.js";
import { buildWidgetLines } from "../src/ui.js";
import { validateFleetSpec } from "../src/dag.js";
import type { FleetSpec } from "../src/types.js";

const execFileP = promisify(execFile);

async function initRepo(dir: string) {
  await execFileP("git", ["init"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileP("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

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
  it("recovers stale 'running' nodes from a crashed process instead of hanging", async () => {
    const sp = spec();
    const fleetRoot = await root();
    // Simulate crash: node a left in non-terminal "running" on disk.
    const resumeFrom = patchNode(fleetRoot, initFleetState(sp), "a", { status: "running" });
    const spawned: string[] = [];
    const s = await runFleet({
      spec: sp,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async (id) => { spawned.push(id); return { ok: true, turns: 1, tokens: 10 }; },
      resumeFrom,
      continuePass: true,
    });
    expect(spawned).toContain("a");
    expect(s.nodes.a.status).toBe("completed");
    expect(s.status).toBe("completed");
  }, 10000);

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
  it("preserves artifact path and failure details on contract_failed", async () => {
    const sp = spec();
    sp.workers[0].outputs = [{ path: "output/findings.md", kind: "markdown", required: true }];
    const fleetRoot = await root();
    const s = await runFleet({
      spec: sp, fleetRoot, repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "a") await writeFile(join(fleetRoot, "workers", "a", "output", "findings.md"), "Status: approved\n\nno heading here");
        return { ok: true, turns: 1, tokens: 5 };
      },
    });
    expect(s.nodes.a.status).toBe("contract_failed");
    expect(s.nodes.a.contract_result?.checks[0].ok).toBe(false);
    expect(s.nodes.a.produced_outputs).toContain("output/findings.md");
    expect(s.nodes.a.status_note).toContain("output/findings.md");
    expect(s.nodes.a.status_note).toContain("no markdown heading after leading metadata line");
    expect(s.nodes.a.status_note).toContain("actual:");
    expect(s.nodes.a.status_note).toContain("Status: approved");
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
  it("does not overwrite killed status with in-flight spawn completion", async () => {
    const sp = spec();
    sp.workers = [sp.workers[0]];
    const killSwitch = { killed: false };
    const s = await runFleet({
      spec: sp, fleetRoot: await root(), repoCwd: "/tmp", killSwitch,
      spawn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        killSwitch.killed = true;
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, turns: 1, tokens: 10 };
      },
    });
    expect(s.status).toBe("killed");
    expect(s.nodes.a.status).toBe("killed");
  });

  it("marks a nodeKills pending node as killed and blocks dependents", async () => {
    const spawned: string[] = [];
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => { spawned.push(id); return { ok: true, turns: 1, tokens: 10 }; },
      nodeKills: new Set(["a"]),
    });
    expect(s.nodes.a.status).toBe("killed");
    expect(s.nodes.b.status).toBe("blocked");
    expect(spawned).not.toContain("a");
  });

  it("kills a blocked node at next scheduler pass while running", async () => {
    const sp = spec();
    const fleetRoot = await root();
    const resumeFrom = patchNode(
      fleetRoot,
      patchNode(fleetRoot, initFleetState(sp), "a", { status: "completed" }),
      "b",
      { status: "blocked" },
    );
    const s = await runFleet({
      spec: sp,
      fleetRoot,
      repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 10 }),
      nodeKills: new Set(["b"]),
      resumeFrom,
      continuePass: true,
    });
    expect(s.nodes.b.status).toBe("killed");
  });

  it("running node killed mid-run ends killed even when spawn succeeds", async () => {
    const kills = new Set<string>();
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "a") kills.add("a"); // kill lands while a is in flight
        return { ok: true, turns: 1, tokens: 10 };
      },
      nodeKills: kills,
    });
    expect(s.nodes.a.status).toBe("killed");
    expect(s.nodes.b.status).toBe("blocked");
  });

  it("failed spawn of a nodeKills node resolves to killed, not failed", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: false, turns: 1, tokens: 10, error: "aborted" }),
      nodeKills: new Set(["a"]),
    });
    expect(s.nodes.a.status).toBe("killed");
  });

  it("auto-initializes spec workers added mid-run and dispatches them", async () => {
    const sp = spec();
    const added: string[] = [];
    const s = await runFleet({
      spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "a") sp.workers.push({ id: "c", type: "write", task: "t", depends_on: ["a"], outputs: [] });
        return { ok: true, turns: 1, tokens: 10 };
      },
      onNodeAdded: async (w) => { added.push(w.id); },
    });
    expect(added).toEqual(["c"]);
    expect(s.nodes.c.status).toBe("completed");
  });

  it("patches status_note returned by onNodeCompleted", async () => {
    const s = await runFleet({
      spec: spec(), fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 10 }),
      onNodeCompleted: async (id) => (id === "a" ? "a-note" : undefined),
    });
    expect(s.nodes.a.status_note).toBe("a-note");
    expect(s.nodes.b.status_note).toBeUndefined();
  });

  it("grows the DAG from onNodeCompleted and runs the new node", async () => {
    const sp = spec();
    const s = await runFleet({
      spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async () => ({ ok: true, turns: 1, tokens: 10 }),
      onNodeCompleted: async (id) => {
        if (id === "b") sp.workers.push({ id: "c", type: "write", task: "t", depends_on: ["b"], outputs: [] });
      },
    });
    expect(s.nodes.c.status).toBe("completed");
  });

  it("mirror state and widget tolerate mid-run spec growth", async () => {
    const sp = spec();
    let mirror = initFleetState(sp);
    const s = await runFleet({
      spec: sp, fleetRoot: await root(), repoCwd: "/tmp",
      spawn: async (id) => {
        if (id === "a") sp.workers.push({ id: "c", type: "write", task: "t", depends_on: ["a"], outputs: [] });
        return { ok: true, turns: 1, tokens: 10 };
      },
      onNodeAdded: (w) => {
        mirror = { ...mirror, nodes: { ...mirror.nodes, [w.id]: { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] } } };
      },
      onNodeChange: (nodeId, nodeState) => {
        mirror = mirror.nodes[nodeId]
          ? patchNode("/x", mirror, nodeId, nodeState)
          : { ...mirror, nodes: { ...mirror.nodes, [nodeId]: nodeState } };
        buildWidgetLines(sp, mirror); // must not throw at any point
      },
    });
    expect(s.nodes.c.status).toBe("completed");
    expect(mirror.nodes.c.status).toBe("completed");
  });
});

describe("runFleet worktrees", () => {
  async function gitRoot() {
    const base = await mkdtemp(join(tmpdir(), "fleet-sched-git-"));
    await initRepo(base);
    return base;
  }

  function worktreeSpec(): FleetSpec {
    return {
      fleet_name: "wt", type: "dag",
      config: { max_concurrent: 2, model: "k2p6" },
      workers: [
        { id: "a", type: "code-run", task: "write a", depends_on: [], outputs: [{ path: "a.txt", kind: "file-exists", required: true }], worktree: true },
        { id: "b", type: "code-run", task: "write b", depends_on: [], outputs: [{ path: "b.txt", kind: "file-exists", required: true }], worktree: true },
      ],
    };
  }

  async function fleetRoot(base: string) {
    const r = join(base, ".fleet", "f-1");
    await mkdir(join(r, "workers", "a", "output"), { recursive: true });
    await mkdir(join(r, "workers", "b", "output"), { recursive: true });
    await mkdir(join(r, "workers", "fleet-integrator", "output"), { recursive: true });
    return r;
  }

  it("creates worktrees, commits, merges, and completes integrator", async () => {
    const base = await gitRoot();
    const root = await fleetRoot(base);
    const v = validateFleetSpec(worktreeSpec());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const s = await runFleet({
      spec: v.spec,
      fleetRoot: root,
      baseRepo: base,
      repoCwd: (nodeId) => join(root, "worktrees", nodeId),
      spawn: async (id) => {
        if (id === "a" || id === "b") {
          await writeFile(join(root, "worktrees", id, `${id}.txt`), id, "utf-8");
        }
        return { ok: true, turns: 1, tokens: 10 };
      },
    });
    expect(s.nodes.a.status).toBe("completed");
    expect(s.nodes.b.status).toBe("completed");
    expect(s.nodes["fleet-integrator"].status).toBe("completed");
  });

  it("fails integrator when worktree branches conflict", async () => {
    const base = await gitRoot();
    const root = await fleetRoot(base);
    const v = validateFleetSpec(worktreeSpec());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const s = await runFleet({
      spec: v.spec,
      fleetRoot: root,
      baseRepo: base,
      repoCwd: (nodeId) => join(root, "worktrees", nodeId),
      spawn: async (id) => {
        if (id === "a" || id === "b") {
          await writeFile(join(root, "worktrees", id, `${id}.txt`), id, "utf-8");
          await writeFile(join(root, "worktrees", id, "shared.txt"), id, "utf-8");
        }
        return { ok: true, turns: 1, tokens: 10 };
      },
    });
    expect(s.nodes.a.status).toBe("completed");
    expect(s.nodes.b.status).toBe("completed");
    expect(s.nodes["fleet-integrator"].status).toBe("failed");
    expect(s.nodes["fleet-integrator"].status_note).toContain("merge");
  });
});
