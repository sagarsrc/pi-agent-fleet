import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startSpinner, type ActiveFleet } from "../src/controller.js";
import { initFleetState, patchNode } from "../src/state.js";
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