import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initFleetState, patchNode, readState, writeState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [{ id: "a", type: "write", task: "t", depends_on: [], outputs: [] }],
};

describe("state", () => {
  it("init -> write -> read roundtrip", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-state-"));
    const s = initFleetState(spec);
    expect(s.status).toBe("planned");
    expect(s.nodes.a.status).toBe("pending");
    await writeState(root, s);
    const back = await readState(root);
    expect(back).toEqual(s);
    const raw = await readFile(join(root, "state.json"), "utf-8");
    expect(JSON.parse(raw).fleet_name).toBe("t");
  });
  it("patchNode is pure and recomputes fleet cost", async () => {
    const s = initFleetState(spec);
    const s2 = patchNode("/unused", s, "a", { status: "completed", cost_usd_estimate: 0.5 });
    expect(s.nodes.a.status).toBe("pending");
    expect(s2.nodes.a.status).toBe("completed");
    expect(s2.cost_usd_estimate).toBe(0.5);
  });
  it("readState tolerates v1 state.json missing new loop fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-state-v1-"));
    const v1 = {
      fleet_name: "t",
      status: "planned",
      created_at: new Date().toISOString(),
      cost_usd_estimate: 0,
      nodes: { a: { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] } },
    };
    await writeFile(join(root, "state.json"), JSON.stringify(v1), "utf-8");
    const back = await readState(root);
    expect(back.iteration).toBe(1);
    expect(back.lgtm_streak).toBe(0);
    expect(back.paused).toBe(false);
    expect(back.iterations).toEqual([]);
    expect(back.fleet_name).toBe("t");
  });
  it("supports concurrent writeState calls without tmp-name race", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-state-race-"));
    const s = initFleetState(spec);
    await Promise.all([writeState(root, s), writeState(root, s)]);
    const back = await readState(root);
    expect(back).toEqual(s);
  });
});
