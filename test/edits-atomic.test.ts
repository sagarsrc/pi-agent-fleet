import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActiveFleet } from "../src/controller.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";
import { fakeModel, registryFor } from "./fakes.js";

const renameCalls: Array<[string, string]> = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      renameCalls.push([String(oldPath), String(newPath)]);
      return actual.rename(oldPath, newPath);
    },
  };
});

const { editConfig, editNode } = await import("../src/edits.js");

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2 },
  workers: [
    { id: "a", type: "research", task: "old task", depends_on: [], outputs: [] },
  ],
};

const registry = registryFor([fakeModel("kimi", "k3")]);

async function freshFleet(): Promise<ActiveFleet> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-edit-atomic-"));
  return {
    spec: structuredClone(spec),
    fleetRoot,
    state: initFleetState(spec),
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: false,
    sessions: new Map(),
    killedNodes: new Set(),
    relaunchRequests: new Set(),
  };
}

describe("atomic fleet.json persistence", () => {
  it("editNode persists fleet.json via tmp write + rename", async () => {
    const fleet = await freshFleet();
    renameCalls.length = 0;
    const r = await editNode(fleet, "a", "model", "k3", registry);
    expect(r.ok).toBe(true);
    const target = join(fleet.fleetRoot, "fleet.json");
    const hit = renameCalls.find(([, to]) => to === target);
    expect(hit, "expected a rename into fleet.json").toBeDefined();
    expect(hit![0]).toContain(".fleet.json.");
    const persisted = JSON.parse(await readFile(target, "utf-8"));
    expect(persisted.workers[0].model).toBe("kimi/k3");
    const leftovers = (await readdir(fleet.fleetRoot)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("editConfig persists fleet.json via tmp write + rename", async () => {
    const fleet = await freshFleet();
    renameCalls.length = 0;
    const r = await editConfig(fleet, "max_concurrent", "4", registry);
    expect(r.ok).toBe(true);
    const target = join(fleet.fleetRoot, "fleet.json");
    expect(renameCalls.some(([, to]) => to === target)).toBe(true);
    const persisted = JSON.parse(await readFile(target, "utf-8"));
    expect(persisted.config.max_concurrent).toBe(4);
  });
});
