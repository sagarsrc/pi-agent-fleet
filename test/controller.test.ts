import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeFleet, drainNodeRequests, ensureCanvas, killFleet, prepareRelaunch, registerNodeSession, startLoop, startSpinner, stopCanvas, type ActiveFleet } from "../src/controller.js";
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
    relaunchRequests: new Set(),
    widgetVisible: true,
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

describe("prepareRelaunch", () => {
  it("clears the node from killedNodes and resets kill/pause switches", () => {
    const fleet = runningFleet();
    fleet.killedNodes.add("a");
    fleet.killSwitch.killed = true;
    fleet.pauseSwitch.paused = true;
    prepareRelaunch(fleet, "a");
    expect(fleet.killedNodes.has("a")).toBe(false);
    expect(fleet.killSwitch.killed).toBe(false);
    expect(fleet.pauseSwitch.paused).toBe(false);
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

  it("kills a blocked node directly when the fleet is not running", async () => {
    const fleet = await plannedFleet();
    fleet.state = patchNode(fleet.fleetRoot, fleet.state, "a", { status: "blocked" });
    await writeState(fleet.fleetRoot, fleet.state);
    activeFleet.current = fleet;
    try {
      const msg = await killFleet("a");
      expect(msg).toBe('node "a" killed');
      expect(fleet.state.nodes.a.status).toBe("killed");
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
      await writeState(fleet.fleetRoot, fleet.state);
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
      await new Promise((r) => setImmediate(r));
      expect(aborted).toBe(true);
      expect(fleet.killedNodes.has("a")).toBe(true);
      expect(msg).toContain('node "a" kill requested');
    } finally {
      activeFleet.current = undefined;
    }
  });

  it("registerNodeSession aborts immediately for killed nodes only", async () => {
    const fleet = runningFleet();
    fleet.killedNodes.add("a");
    let abortedA = false;
    let abortedB = false;
    registerNodeSession(fleet, "a", { prompt: async () => {}, abort: async () => { abortedA = true; }, subscribe: () => () => {}, dispose: () => {} });
    registerNodeSession(fleet, "b", { prompt: async () => {}, abort: async () => { abortedB = true; }, subscribe: () => () => {}, dispose: () => {} });
    await new Promise((r) => setImmediate(r));
    expect(abortedA).toBe(true);
    expect(abortedB).toBe(false);
  });
});

describe("canvas lifecycle", () => {
  it("ensureCanvas returns a singleton and stopCanvas tears it down", async () => {
    const a = await ensureCanvas({ cwd: "/tmp" } as unknown as ExtensionContext);
    const b = await ensureCanvas({ cwd: "/tmp" } as unknown as ExtensionContext);
    expect(a).toBe(b);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await stopCanvas();
    const c = await ensureCanvas({ cwd: "/tmp" } as unknown as ExtensionContext);
    expect(c).not.toBe(a);
    await stopCanvas();
  });

  it("serves the active fleet through the cell", async () => {
    const server = await ensureCanvas({ cwd: "/tmp" } as unknown as ExtensionContext);
    activeFleet.current = runningFleet();
    try {
      const state = await (await fetch(`${server.url}/api/state`)).json();
      expect(state.fleet_name).toBe("t");
    } finally {
      activeFleet.current = undefined;
      await stopCanvas();
    }
  });
});

describe("node request sideband", () => {
  it("inserts workers requested by a completed node", async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-sideband-"));
    const fleet = runningFleet();
    fleet.fleetRoot = fleetRoot;
    await mkdir(join(fleetRoot, "workers", "a", "output"), { recursive: true });
    await writeFile(join(fleetRoot, "workers", "a", "output", "node-requests.json"),
      JSON.stringify({ workers: [{ id: "c", type: "write", task: "extra", depends_on: ["a"] }] }), "utf-8");
    const registry = { getAvailable: () => [], getAll: () => [] };
    const note = await drainNodeRequests(fleet, "a", registry);
    expect(note).toBeUndefined();
    expect(fleet.spec.workers.map((w) => w.id)).toContain("c");
  });

  it("returns a note for invalid request JSON", async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-sideband-"));
    const fleet = runningFleet();
    fleet.fleetRoot = fleetRoot;
    await mkdir(join(fleetRoot, "workers", "a", "output"), { recursive: true });
    await writeFile(join(fleetRoot, "workers", "a", "output", "node-requests.json"), "{junk", "utf-8");
    const registry = { getAvailable: () => [], getAll: () => [] };
    const note = await drainNodeRequests(fleet, "a", registry);
    expect(note).toContain("node-requests");
  });

  it("returns undefined when no sideband file exists", async () => {
    const fleet = runningFleet();
    fleet.fleetRoot = await mkdtemp(join(tmpdir(), "fleet-sideband-"));
    const registry = { getAvailable: () => [], getAll: () => [] };
    expect(await drainNodeRequests(fleet, "a", registry)).toBeUndefined();
  });
});
