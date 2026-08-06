import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReport } from "../src/report.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1 },
  workers: [
    { id: "a", type: "write", task: "do thing", depends_on: [], outputs: [{ path: "output/numbers.json", kind: "json", required: true }] },
    { id: "b", type: "write", task: "do more", depends_on: ["a"], outputs: [] },
  ],
};

describe("writeReport next actions + json outputs", () => {
  it("includes ## Next steps with fleet_relaunch <id> for failed nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-next-"));
    let state = initFleetState(spec);
    state = { ...state, status: "failed" };
    state = patchNode(root, state, "a", { status: "failed" });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("## Next steps");
    expect(md).toContain("fleet_relaunch a");
  });

  it("points at the report when the fleet completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-next-"));
    let state = initFleetState(spec);
    state = { ...state, status: "completed" };
    state = patchNode(root, state, "a", { status: "completed" });
    state = patchNode(root, state, "b", { status: "completed" });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("## Next steps");
    expect(md).toContain(join(root, "report.md"));
  });

  it("inlines small JSON outputs under ## JSON outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-next-"));
    await mkdir(join(root, "workers", "a", "output"), { recursive: true });
    await writeFile(join(root, "workers", "a", "output", "numbers.json"), JSON.stringify({ values: [1, 2, 3] }), "utf-8");
    let state = initFleetState(spec);
    state = { ...state, status: "completed" };
    state = patchNode(root, state, "a", { status: "completed", produced_outputs: ["output/numbers.json"] });
    state = patchNode(root, state, "b", { status: "completed" });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("## JSON outputs");
    expect(md).toContain("```json");
    expect(md).toContain('"values"');
  });

  it("skips produced output paths containing ..", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-next-"));
    let state = initFleetState(spec);
    state = { ...state, status: "completed" };
    state = patchNode(root, state, "a", { status: "completed", produced_outputs: ["output/../../secret.json", "output/numbers.json"] });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("## JSON outputs");
    expect(md).not.toContain("### a: output/..");
  });

  it("truncates JSON outputs larger than 4096 bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-next-"));
    await mkdir(join(root, "workers", "a", "output"), { recursive: true });
    await writeFile(join(root, "workers", "a", "output", "numbers.json"), JSON.stringify({ values: "x".repeat(8000) }), "utf-8");
    let state = initFleetState(spec);
    state = { ...state, status: "completed" };
    state = patchNode(root, state, "a", { status: "completed", produced_outputs: ["output/numbers.json"] });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("## JSON outputs");
    expect(md).toContain("truncated");
  });
});
