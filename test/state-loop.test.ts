import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveIteration, initFleetState, resetForIteration, snapshotIteration } from "../src/state.js";
import type { ContractResult, FleetSpec, NodeState } from "../src/types.js";

const loopSpec: FleetSpec = {
  fleet_name: "loop",
  type: "dag",
  config: {
    max_concurrent: 1,
    model: "k2p6",
    loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 1 },
  },
  workers: [
    { id: "replay", type: "write", task: "t", depends_on: [], outputs: [] },
    { id: "once", type: "write", task: "t", depends_on: [], outputs: [], iterate: false },
  ],
};

describe("state loop", () => {
  it("snapshotIteration appends a structured clone with n, verdict, and earliest started_at", () => {
    const state = initFleetState(loopSpec);
    const started = new Date(Date.now() - 1000).toISOString();
    const patched: NodeState = { ...state.nodes.replay, status: "completed", started_at: started, ended_at: new Date().toISOString(), cost_usd_estimate: 0.1 };
    const working = { ...state, nodes: { ...state.nodes, replay: patched } };

    const snap = snapshotIteration(working, "iterate", "fix it");

    expect(snap.iterations).toHaveLength(1);
    const it = snap.iterations[0];
    expect(it.n).toBe(1);
    expect(it.verdict).toBe("iterate");
    expect(it.verdict_body).toBe("fix it");
    expect(it.started_at).toBe(started);
    expect(it.ended_at).toMatch(/^\d{4}-/);
    expect(it.nodes.replay.status).toBe("completed");
    expect(it.nodes.replay.cost_usd_estimate).toBe(0.1);

    // Mutation of original nodes does not affect the snapshot.
    const mutated = { ...working, nodes: { ...working.nodes, replay: { ...patched, status: "failed" } } };
    expect(snap.iterations[0].nodes.replay.status).toBe("completed");
    expect(mutated).not.toBe(snap);
  });

  it("resetForIteration increments iteration and resets replay nodes only", () => {
    const state = initFleetState(loopSpec);
    const completedState: NodeState = {
      status: "completed",
      turns: 2,
      tokens: 30,
      cost_usd_estimate: 0.5,
      contract_result: { ok: true, checks: [], verdict: "lgtm", verdict_body: "ok" },
      produced_outputs: ["out.md"],
      status_note: "done",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    };
    const working = {
      ...state,
      nodes: {
        replay: completedState,
        once: { ...completedState, contract_result: { ...completedState.contract_result!, verdict_body: "once" } as ContractResult },
      },
      iteration: 1,
      lgtm_streak: 1,
    };

    const next = resetForIteration(working, loopSpec);

    expect(next.iteration).toBe(2);
    expect(next.lgtm_streak).toBe(1);
    expect(next.nodes.replay).toEqual({ status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] });
    expect(next.nodes.once).toEqual({
      ...completedState,
      contract_result: { ok: true, checks: [], verdict: "lgtm", verdict_body: "once" },
    });
  });

  it("archiveIteration copies output dirs and prompt.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-archive-"));
    await mkdir(join(root, "workers", "a", "output"), { recursive: true });
    await writeFile(join(root, "workers", "a", "output", "x.txt"), "hello", "utf-8");
    await writeFile(join(root, "workers", "a", "prompt.md"), "prompt", "utf-8");

    await archiveIteration(root, 1, ["a"]);

    const archivedOutput = await readFile(join(root, "iterations", "1", "workers", "a", "output", "x.txt"), "utf-8");
    expect(archivedOutput).toBe("hello");
    const archivedPrompt = await readFile(join(root, "iterations", "1", "workers", "a-prompt.md"), "utf-8");
    expect(archivedPrompt).toBe("prompt");
  });

  it("snapshotIteration uses earliest started_at from replay nodes when spec is provided", () => {
    const state = initFleetState(loopSpec);
    const onceStart = new Date(Date.now() - 600000).toISOString();
    const replayStart = new Date(Date.now() - 10000).toISOString();
    const nodes = {
      once: { ...state.nodes.once, status: "completed" as const, started_at: onceStart, ended_at: new Date().toISOString() },
      replay: { ...state.nodes.replay, status: "completed" as const, started_at: replayStart, ended_at: new Date().toISOString() },
    };
    const working = { ...state, nodes };

    const snap = snapshotIteration(working, null, null, loopSpec);

    expect(snap.iterations).toHaveLength(1);
    expect(snap.iterations[0].started_at).toBe(replayStart);
  });

  it("snapshotIteration archives costs and zeros live node costs", () => {
    const state = initFleetState(loopSpec);
    const nodes = {
      once: { ...state.nodes.once, status: "completed" as const, cost_usd_estimate: 0.2 },
      replay: { ...state.nodes.replay, status: "completed" as const, cost_usd_estimate: 0.1 },
    };
    const working = { ...state, nodes };

    const snap = snapshotIteration(working, null, null, loopSpec);

    expect(snap.iterations[0].nodes.once.cost_usd_estimate).toBe(0.2);
    expect(snap.iterations[0].nodes.replay.cost_usd_estimate).toBe(0.1);
    expect(snap.nodes.once.cost_usd_estimate).toBe(0);
    expect(snap.nodes.replay.cost_usd_estimate).toBe(0);
  });
});
