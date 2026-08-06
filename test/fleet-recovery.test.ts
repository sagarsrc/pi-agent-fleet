import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFleetRoots, readDiskFleet, recoverLatestFleet } from "../src/fleet-recovery.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const minimalSpec: FleetSpec = {
  fleet_name: "demo", type: "dag",
  config: { max_concurrent: 1 },
  workers: [{ id: "a", type: "write", task: "t", depends_on: [], outputs: [] }],
};

async function diskRoot(dir: string, name = "demo-20260101000000"): Promise<string> {
  const root = join(dir, ".fleet", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "fleet.json"), JSON.stringify(minimalSpec), "utf-8");
  await writeFile(join(root, "state.json"), JSON.stringify(initFleetState(minimalSpec)), "utf-8");
  return root;
}

describe("recoverLatestFleet", () => {
  it("recovers latest fleet root from disk when activeFleet is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
    const root = await diskRoot(dir);
    const recovered = await recoverLatestFleet(dir);
    expect(recovered?.fleetRoot).toBe(root);
    expect(recovered?.spec.fleet_name).toBe("demo");
    expect(recovered?.running).toBe(false);
  });

  it("returns undefined when no fleet roots exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
    expect(await recoverLatestFleet(dir)).toBeUndefined();
  });

  it("skips design dirs without fleet.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
    await mkdir(join(dir, ".fleet", "design-x-2026", "planner"), { recursive: true });
    expect(await recoverLatestFleet(dir)).toBeUndefined();
  });
});

describe("readDiskFleet + listFleetRoots (moved from canvas)", () => {
  it("lists roots and reads a disk fleet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
    const root = await diskRoot(dir);
    const roots = await listFleetRoots(dir);
    expect(roots.length).toBe(1);
    expect(roots[0].root).toBe(root);
    expect(roots[0].status).toBe("planned");
    const f = await readDiskFleet(root);
    expect(f.spec.fleet_name).toBe("demo");
    expect(f.state.status).toBe("planned");
  });
});
