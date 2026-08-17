import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeFleet, killFleet, type ActiveFleet } from "../src/controller.js";
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

describe("killFleet on a disk-recovered fleet still running elsewhere", () => {
  it("warns instead of writing killed when disk state.status is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
    const root = await diskRoot(dir);
    const runningState = { ...initFleetState(minimalSpec), status: "running" as const };
    runningState.nodes.a = { ...runningState.nodes.a, status: "running" as const };
    await writeFile(join(root, "state.json"), JSON.stringify(runningState), "utf-8");
    activeFleet.current = undefined;
    try {
      const msg = await killFleet("a", dir);
      expect(msg).toContain("another live session");
      expect(msg).not.toContain('node "a" killed');
      const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf-8"));
      expect(persisted.nodes.a.status).toBe("running");
      expect(persisted.status).toBe("running");
    } finally {
      activeFleet.current = undefined;
    }
  });

  it('warns instead of setting the kill switch for target "all" when disk state.status is running', async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-recover-"));
    const root = await diskRoot(dir);
    const runningState = { ...initFleetState(minimalSpec), status: "running" as const };
    runningState.nodes.a = { ...runningState.nodes.a, status: "running" as const };
    await writeFile(join(root, "state.json"), JSON.stringify(runningState), "utf-8");
    activeFleet.current = undefined;
    try {
      const msg = await killFleet("all", dir);
      expect(msg).toContain("another live session");
      expect(msg).not.toContain("fleet kill requested");
      const current = activeFleet.current as ActiveFleet | undefined;
      expect(current?.killSwitch.killed).toBe(false);
      const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf-8"));
      expect(persisted.status).toBe("running");
    } finally {
      activeFleet.current = undefined;
    }
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

  it("synthesizes a pending state for a bare fleet.json-only root", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-bare-"));
    await writeFile(join(root, "fleet.json"), JSON.stringify(minimalSpec), "utf-8");
    const fleet = await readDiskFleet(root);
    expect(fleet.state.status).toBe("planned");
    expect(Object.keys(fleet.state.nodes)).toEqual(minimalSpec.workers.map((w) => w.id));
  });

  it("throws for corrupt state.json even when fleet.json exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-corrupt-"));
    await writeFile(join(root, "fleet.json"), JSON.stringify(minimalSpec), "utf-8");
    await writeFile(join(root, "state.json"), "{}", "utf-8");
    await expect(readDiskFleet(root)).rejects.toThrow();
  });
});
