import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveFleet } from "../src/controller.js";
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

const { registerFleetTools } = await import("../src/tools.js");
const { registerFleetCommand } = await import("../src/command.js");
const { activeFleet } = await import("../src/controller.js");
const { initFleetState } = await import("../src/state.js");

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1 },
  workers: [
    { id: "a", type: "research", task: "old task", depends_on: [], outputs: [] },
  ],
};

const registry = registryFor([fakeModel("kimi", "k3")]);

async function failedFleet(): Promise<ActiveFleet> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-relaunch-atomic-"));
  const base = initFleetState(spec);
  const fleet: ActiveFleet = {
    spec: structuredClone(spec),
    fleetRoot,
    state: {
      ...base,
      status: "failed",
      nodes: { a: { ...base.nodes.a, status: "failed" } },
    },
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: false,
    sessions: new Map(),
    killedNodes: new Set(),
    relaunchRequests: new Set(),
  };
  activeFleet.current = fleet;
  return fleet;
}

function ctxFor(): { ctx: ExtensionContext; notes: string[] } {
  const notes: string[] = [];
  const ctx = {
    cwd: "/tmp/fleet-relaunch-atomic-test",
    hasUI: false,
    modelRegistry: registry,
    ui: {
      notify: (message: string) => {
        notes.push(message);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notes };
}

interface CapturedTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function captureTool(name: string): CapturedTool {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (def: CapturedTool) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  registerFleetTools(pi);
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool;
}

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;

function captureCommand(): Handler {
  let handler: Handler | undefined;
  const pi = {
    registerCommand: (_name: string, def: { handler: Handler }) => {
      handler = def.handler;
    },
  } as unknown as ExtensionAPI;
  registerFleetCommand(pi);
  if (!handler) throw new Error("fleet command not registered");
  return handler;
}

afterEach(() => {
  activeFleet.current = undefined;
  renameCalls.length = 0;
});

async function expectAtomicModelOverride(fleet: ActiveFleet): Promise<void> {
  const target = join(fleet.fleetRoot, "fleet.json");
  const hit = renameCalls.find(([, to]) => to === target);
  expect(hit, "expected a rename into fleet.json").toBeDefined();
  expect(hit![0]).toContain(".fleet.json.");
  const persisted = JSON.parse(await readFile(target, "utf-8"));
  expect(persisted.workers[0].model).toBe("kimi/k3");
  const leftovers = (await readdir(fleet.fleetRoot)).filter((f) => f.startsWith(".fleet.json.") && f.endsWith(".tmp"));
  expect(leftovers).toEqual([]);
}

describe("atomic fleet.json persistence for relaunch model overrides", () => {
  it("fleet_relaunch tool persists model override via tmp write + rename", async () => {
    const fleet = await failedFleet();
    const { ctx } = ctxFor();
    const tool = captureTool("fleet_relaunch");
    renameCalls.length = 0;
    const result = await tool.execute("id", { node_id: "a", model: "k3" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("relaunch requested");
    await expectAtomicModelOverride(fleet);
  });

  it("/fleet relaunch <node> <model> persists model override via tmp write + rename", async () => {
    const fleet = await failedFleet();
    const { ctx, notes } = ctxFor();
    const handler = captureCommand();
    renameCalls.length = 0;
    await handler("relaunch a k3", ctx);
    expect(notes.some((n) => n.includes("relaunch requested"))).toBe(true);
    await expectAtomicModelOverride(fleet);
  });
});
