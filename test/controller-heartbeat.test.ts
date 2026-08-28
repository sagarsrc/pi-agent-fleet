import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkCostLimits, statusText, type ActiveFleet } from "../src/controller.js";
import { initFleetState } from "../src/state.js";
import type { FleetConfig, FleetSpec, FleetState } from "../src/types.js";

function makeFleet(overrides: { config?: Partial<FleetConfig>; state?: Partial<FleetState> } = {}): ActiveFleet {
  const spec: FleetSpec = {
    fleet_name: "t",
    type: "dag",
    config: { max_concurrent: 1, ...overrides.config },
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };
  const state = { ...initFleetState(spec), status: "running" as const, ...overrides.state };
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
    widgetVisible: false,
  };
}

function captureCtx(): ExtensionContext & { ui: { notify: ReturnType<typeof vi.fn> } } {
  return {
    hasUI: true,
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext & { ui: { notify: ReturnType<typeof vi.fn> } };
}

describe("checkCostLimits", () => {
  it("sets killSwitch.killed when cost estimate reaches max_cost_usd", () => {
    const fleet = makeFleet({ config: { max_cost_usd: 5 } });
    fleet.state.cost_usd_estimate = 5;
    const ctx = captureCtx();
    checkCostLimits(fleet, ctx);
    expect(fleet.killSwitch.killed).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("fleet cost cap reached: $5.0000 >= $5.0000", "error");
  });

  it("does not kill when cost is below the cap", () => {
    const fleet = makeFleet({ config: { max_cost_usd: 5 } });
    fleet.state.cost_usd_estimate = 4.99;
    const ctx = captureCtx();
    checkCostLimits(fleet, ctx);
    expect(fleet.killSwitch.killed).toBe(false);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});

describe("statusText crash detection", () => {
  it("appends crash warning for running fleet with dead pid and stale heartbeat", async () => {
    const fleet = makeFleet({
      state: {
        status: "running",
        pid: 2 ** 22,
        heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      },
    });
    const text = await statusText(fleet);
    expect(text).toContain("warning: fleet appears crashed");
    expect(text).toContain(`dead pid ${2 ** 22}`);
  });

  it("shows no warning when heartbeat is fresh", async () => {
    const fleet = makeFleet({
      state: {
        status: "running",
        pid: 2 ** 22,
        heartbeat_at: new Date().toISOString(),
      },
    });
    const text = await statusText(fleet);
    expect(text).not.toContain("appears crashed");
  });
});
