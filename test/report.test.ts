import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiffStat, writeReport } from "../src/report.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 1, model: "k2p6" },
  workers: [{ id: "a", type: "write", task: "do thing", depends_on: [], outputs: [] }],
};

describe("writeReport", () => {
  it("writes report.md with dag, node table, totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-report-"));
    let state = initFleetState(spec);
    state = { ...state, status: "completed" };
    state = patchNode(root, state, "a", { status: "completed", turns: 3, tokens: 1000, cost_usd_estimate: 0.02 });
    const md = await writeReport({ spec, state, fleetRoot: root, repoCwd: "/nonexistent" });
    expect(md).toContain("# Fleet report: t");
    expect(md).toContain("completed");
    expect(md).toContain("| a |");
    expect(md).toContain("$0.02");
  });
});

describe("gitDiffStat", () => {
  it("degrades gracefully outside a git repo", async () => {
    expect(await gitDiffStat("/nonexistent", new Date().toISOString())).toBe("(not a git repo)");
  });
});
