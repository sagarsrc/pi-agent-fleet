import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveFleet } from "../src/controller.js";
import { insertWorkers } from "../src/insert.js";
import { initFleetState, writeState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { fakeModel, registryFor } from "./fakes.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

async function plannedFleet(running = false): Promise<ActiveFleet> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-insert-"));
  const state = initFleetState(spec);
  await writeState(fleetRoot, state);
  return {
    spec: structuredClone(spec),
    fleetRoot,
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running,
    sessions: new Map(),
    killedNodes: new Set(),
    relaunchRequests: new Set(),
  };
}

const registry = registryFor([fakeModel("openai", "gpt-5.4"), fakeModel("kimi", "k3")]);

describe("insertWorkers", () => {
  it("inserts a node on a non-running fleet: state, dirs, prompt, fleet.json", async () => {
    const fleet = await plannedFleet(false);
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "do c", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(true);
    expect(r.inserted).toEqual(["c"]);
    expect(fleet.spec.workers.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(fleet.state.nodes.c.status).toBe("pending");
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.workers.map((w: { id: string }) => w.id)).toContain("c");
    const state = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
    expect(state.nodes.c.status).toBe("pending");
    expect((await stat(join(fleet.fleetRoot, "workers", "c", "output"))).isDirectory()).toBe(true);
    const prompt = await readFile(join(fleet.fleetRoot, "workers", "c", "prompt.md"), "utf-8");
    expect(prompt).toContain("do c");
  });

  it("does not touch state.json when the fleet is running", async () => {
    const fleet = await plannedFleet(true);
    const before = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "do c", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(true);
    const after = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
    expect(after.nodes.c).toBeUndefined();
    expect(after).toEqual(before);
    expect(fleet.state.nodes.c).toBeUndefined(); // scheduler auto-init owns state mid-run
  });

  it("rejects the whole batch on any validation error", async () => {
    const fleet = await plannedFleet(false);
    const r = await insertWorkers(fleet, [
      { id: "c", type: "write", task: "ok", depends_on: ["b"] },
      { id: "a", type: "write", task: "dupe", depends_on: [] },
    ], registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("duplicate");
    expect(fleet.spec.workers.length).toBe(2);
  });

  it("rejects unknown deps and cycles", async () => {
    const fleet = await plannedFleet(false);
    expect((await insertWorkers(fleet, [{ id: "c", type: "write", task: "t", depends_on: ["ghost"] }], registry)).ok).toBe(false);
    const cyc = await insertWorkers(fleet, [
      { id: "c", type: "write", task: "t", depends_on: ["d"] },
      { id: "d", type: "write", task: "t", depends_on: ["c"] },
    ], registry);
    expect(cyc.ok).toBe(false);
    expect(cyc.message).toContain("CYCLE");
  });

  it("canonicalizes explicit model refs and rejects bad ones", async () => {
    const fleet = await plannedFleet(false);
    const ok = await insertWorkers(fleet, [{ id: "c", type: "write", task: "t", depends_on: ["b"], model: "k3" }], registry);
    expect(ok.ok).toBe(true);
    expect(fleet.spec.workers[2].model).toBe("kimi/k3");
    const bad = await insertWorkers(fleet, [{ id: "e", type: "write", task: "t", depends_on: ["b"], model: "ghost" }], registry);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("ghost");
  });

  it("refuses insertion into a completed fleet", async () => {
    const fleet = await plannedFleet(false);
    fleet.state = { ...fleet.state, status: "completed" };
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "t", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("completed");
  });

  it("rejects empty/malformed input", async () => {
    const fleet = await plannedFleet(false);
    expect((await insertWorkers(fleet, [], registry)).ok).toBe(false);
    expect((await insertWorkers(fleet, { nope: true }, registry)).ok).toBe(false);
    expect((await insertWorkers(fleet, "junk", registry)).ok).toBe(false);
  });

  it("enforces loop-gate rules on the merged graph", async () => {
    const fleet = await plannedFleet(false);
    fleet.spec.config.loop = { gate: "reviewer", max_iterations: 2, lgtm_count: 1 };
    fleet.spec.workers[1].outputs = [{ path: "output/review.md", kind: "verdict", required: true }];
    const r = await insertWorkers(fleet, [{
      id: "c", type: "reviewer", task: "second reviewer", depends_on: ["b"],
      outputs: [{ path: "output/review2.md", kind: "verdict", required: true }],
    }], registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("verdict");
  });

  it("does not mutate fleet.spec when prompt writing fails", async () => {
    const fleet = await plannedFleet(false);
    await writeFile(join(fleet.fleetRoot, "fleet.json"), JSON.stringify(fleet.spec), "utf-8");
    // make the workers dir a FILE so mkdir recursive fails
    await writeFile(join(fleet.fleetRoot, "workers"), "not a dir", "utf-8");
    const r = await insertWorkers(fleet, [{ id: "c", type: "write", task: "do c", depends_on: ["b"] }], registry);
    expect(r.ok).toBe(false);
    expect(fleet.spec.workers.length).toBe(2);
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.workers.length).toBe(2);
  });
});
