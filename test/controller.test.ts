import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeFleet, killFleet, startLoop, startSpinner, type ActiveFleet } from "../src/controller.js";
import { initFleetState, patchNode, writeState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

function runningFleet(): ActiveFleet {
  const spec: FleetSpec = {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 1, model: "m" },
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };
  const state = patchNode("/x", initFleetState(spec), "a", { status: "running" });
  return {
    spec,
    fleetRoot: "/x",
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: true,
    sessions: new Map(),
    killedNodes: new Set(),
  };
}

describe("startSpinner", () => {
  it("re-renders the widget with advancing frames until stopped", () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: { setWidget: (_id: string, lines: string[]) => calls.push(lines) },
    } as unknown as ExtensionContext;
    const stop = startSpinner(ctx, runningFleet(), 100);
    vi.advanceTimersByTime(250);
    stop();
    vi.useRealTimers();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].join("\n")).not.toBe(calls[1].join("\n"));
  });

  it("no-ops without UI", () => {
    const ctx = { hasUI: false } as unknown as ExtensionContext;
    const stop = startSpinner(ctx, runningFleet(), 100);
    expect(() => stop()).not.toThrow();
  });
});

describe("startLoop", () => {
  it("resume with unreadable state.json fails cleanly without starting the spinner", async () => {
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget: () => {},
        notify: (msg: string) => notifications.push(msg),
      },
    } as unknown as ExtensionContext;
    const fleet = runningFleet();
    fleet.fleetRoot = "/nonexistent/fleet/root";
    await startLoop(fleet, ctx, true);
    expect(fleet.running).toBe(false);
    expect(notifications.some((m) => m.startsWith("fleet failed:"))).toBe(true);
  });
});

describe("killFleet node targets", () => {
  async function plannedFleet(): Promise<ActiveFleet> {
    const fleet = runningFleet();
    fleet.fleetRoot = await mkdtemp(join(tmpdir(), "fleet-kill-"));
    fleet.running = false;
    fleet.state = initFleetState(fleet.spec);
    await writeState(fleet.fleetRoot, fleet.state);
    return fleet;
  }

  it("kills a pending node directly when the fleet is not running", async () => {
    const fleet = await plannedFleet();
    activeFleet.current = fleet;
    try {
      const msg = await killFleet("a");
      expect(msg).toBe('node "a" killed');
      expect(fleet.state.nodes.a.status).toBe("killed");
      const persisted = JSON.parse(await readFile(join(fleet.fleetRoot, "state.json"), "utf-8"));
      expect(persisted.nodes.a.status).toBe("killed");
    } finally {
      activeFleet.current = undefined;
    }
  });

  it("rejects unknown nodes and terminal nodes", async () => {
    const fleet = await plannedFleet();
    activeFleet.current = fleet;
    try {
      expect(await killFleet("zzz")).toContain('unknown node "zzz"');
      fleet.state = patchNode(fleet.fleetRoot, fleet.state, "a", { status: "completed" });
      expect(await killFleet("a")).toContain("already completed");
    } finally {
      activeFleet.current = undefined;
    }
  });

  it("aborts the live session of a running node", async () => {
    const fleet = await plannedFleet();
    fleet.running = true;
    let aborted = false;
    fleet.sessions.set("a", {
      prompt: async () => {},
      abort: async () => { aborted = true; },
      subscribe: () => () => {},
      dispose: () => {},
    });
    fleet.state = patchNode(fleet.fleetRoot, fleet.state, "a", { status: "running" });
    activeFleet.current = fleet;
    try {
      const msg = await killFleet("a");
      expect(aborted).toBe(true);
      expect(fleet.killedNodes.has("a")).toBe(true);
      expect(msg).toContain('node "a" kill requested');
    } finally {
      activeFleet.current = undefined;
    }
  });
});
