import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveFleet } from "../src/controller.js";
import { editConfig, editNode } from "../src/edits.js";
import { buildWorkerPrompt } from "../src/prompts.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { fakeModel, registryFor } from "./fakes.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "old task", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

async function fleetAt(status: "pending" | "running"): Promise<ActiveFleet> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-edit-"));
  let state = initFleetState(spec);
  if (status === "running") state = patchNode(fleetRoot, state, "a", { status: "running" });
  return {
    spec: structuredClone(spec),
    fleetRoot,
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: false,
    sessions: new Map(),
    killedNodes: new Set(),
    relaunchRequests: new Set(),
  };
}

const registry = registryFor([fakeModel("openai", "gpt-5.4"), fakeModel("kimi", "k3")]);

describe("editNode", () => {
  it("sets a canonical model on a pending node and persists fleet.json", async () => {
    const fleet = await fleetAt("pending");
    const r = await editNode(fleet, "a", "model", "k3", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].model).toBe("kimi/k3");
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.workers[0].model).toBe("kimi/k3");
  });

  it("rejects edits to a running or completed node", async () => {
    const fleet = await fleetAt("running");
    const r = await editNode(fleet, "a", "model", "k3", registry);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("running");
  });

  it("allows editing a failed node and regenerates prompt.md", async () => {
    const fleet = await fleetAt("pending");
    fleet.state.nodes.a = { ...fleet.state.nodes.a, status: "failed" };
    const dir = join(fleet.fleetRoot, "workers", "a");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: "a", fleetRoot: fleet.fleetRoot }), "utf-8");
    const r = await editNode(fleet, "a", "task", "fixed task after failure", registry);
    expect(r.ok).toBe(true);
    const prompt = await readFile(join(dir, "prompt.md"), "utf-8");
    expect(prompt).toContain("fixed task after failure");
  });

  it("allows task edit on a blocked node", async () => {
    const fleet = await fleetAt("pending");
    fleet.state.nodes.a = { ...fleet.state.nodes.a, status: "blocked" };
    const r = await editNode(fleet, "a", "task", "fixed task before relaunch", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].task).toBe("fixed task before relaunch");
  });

  it("rejects unknown nodes, unknown keys, and bad values", async () => {
    const fleet = await fleetAt("pending");
    expect((await editNode(fleet, "zzz", "model", "k3", registry)).ok).toBe(false);
    expect((await editNode(fleet, "a", "nope" as never, "x", registry)).message).toContain("unknown node edit key");
    expect((await editNode(fleet, "a", "model", "ghost", registry)).ok).toBe(false);
    expect((await editNode(fleet, "a", "effort", "maxed", registry)).ok).toBe(false);
  });

  it("sets effort on a pending node", async () => {
    const fleet = await fleetAt("pending");
    const r = await editNode(fleet, "b", "effort", "high", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[1].effort).toBe("high");
  });

  it("updates task and regenerates prompt.md when present", async () => {
    const fleet = await fleetAt("pending");
    const dir = join(fleet.fleetRoot, "workers", "a");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: "a", fleetRoot: fleet.fleetRoot }), "utf-8");
    const r = await editNode(fleet, "a", "task", "brand new task", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].task).toBe("brand new task");
    const prompt = await readFile(join(dir, "prompt.md"), "utf-8");
    expect(prompt).toContain("brand new task");
  });

  it("updates task without prompt.md present", async () => {
    const fleet = await fleetAt("pending");
    const r = await editNode(fleet, "a", "task", "another task", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.workers[0].task).toBe("another task");
  });
});

describe("editConfig", () => {
  it("sets max_concurrent and persists", async () => {
    const fleet = await fleetAt("pending");
    const r = await editConfig(fleet, "max_concurrent", "8", registry);
    expect(r.ok).toBe(true);
    expect(fleet.spec.config.max_concurrent).toBe(8);
    const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "fleet.json"), "utf-8"));
    expect(persisted.config.max_concurrent).toBe(8);
  });

  it("validates values", async () => {
    const fleet = await fleetAt("pending");
    expect((await editConfig(fleet, "max_concurrent", "0", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "warn_cost_usd", "-2", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "effort", "maxed", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "model", "ghost", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "nope" as never, "1", registry)).message).toContain("unknown config key");
  });

  it("sets max_cost_usd, effort, and canonical model", async () => {
    const fleet = await fleetAt("pending");
    expect((await editConfig(fleet, "max_cost_usd", "10", registry)).ok).toBe(true);
    expect(fleet.spec.config.max_cost_usd).toBe(10);
    expect((await editConfig(fleet, "warn_cost_usd", "3.5", registry)).ok).toBe(true);
    expect(fleet.spec.config.warn_cost_usd).toBe(3.5);
    expect((await editConfig(fleet, "effort", "low", registry)).ok).toBe(true);
    expect(fleet.spec.config.effort).toBe("low");
    expect((await editConfig(fleet, "model", "gpt-5.4", registry)).ok).toBe(true);
    expect(fleet.spec.config.model).toBe("openai/gpt-5.4");
  });

  it("validates max_cost_usd values", async () => {
    const fleet = await fleetAt("pending");
    expect((await editConfig(fleet, "max_cost_usd", "-2", registry)).ok).toBe(false);
    expect((await editConfig(fleet, "max_cost_usd", "abc", registry)).ok).toBe(false);
  });
});
