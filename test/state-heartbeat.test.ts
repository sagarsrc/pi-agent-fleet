import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initFleetState, readState, writeState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [{ id: "a", type: "write", task: "t", depends_on: [], outputs: [] }],
};

describe("state heartbeat liveness fields", () => {
  it("writeState -> readState roundtrip preserves pid and heartbeat_at", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-state-heartbeat-"));
    const s = initFleetState(spec);
    s.pid = 12345;
    s.heartbeat_at = new Date().toISOString();
    await writeState(root, s);
    const back = await readState(root);
    expect(back.pid).toBe(12345);
    expect(back.heartbeat_at).toBe(s.heartbeat_at);
  });

  it("readState without pid/heartbeat_at yields undefined, not crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-state-no-heartbeat-"));
    const s = initFleetState(spec);
    await writeState(root, s);
    const back = await readState(root);
    expect(back.pid).toBeUndefined();
    expect(back.heartbeat_at).toBeUndefined();
  });
});
