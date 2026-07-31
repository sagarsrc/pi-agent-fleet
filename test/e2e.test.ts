import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReport } from "../src/report.js";
import { runFleet } from "../src/scheduler.js";
import { readState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

describe("e2e pipeline (fake spawn)", () => {
  it("research -> summarize completes with contracts and report", async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), "fleet-e2e-"));
    const spec: FleetSpec = {
      fleet_name: "smoke", type: "dag",
      config: { max_concurrent: 2, model: "gpt-5.4-mini" },
      workers: [
        { id: "research", type: "research", task: "t", depends_on: [],
          outputs: [{ path: "output/findings.md", kind: "markdown", required: true }] },
        { id: "summarize", type: "write", task: "t", depends_on: ["research"],
          outputs: [{ path: "output/summary.md", kind: "markdown", required: true }] },
      ],
    };
    const { mkdir, writeFile } = await import("node:fs/promises");
    for (const id of ["research", "summarize"]) {
      await mkdir(join(fleetRoot, "workers", id, "output"), { recursive: true });
    }
    const state = await runFleet({
      spec, fleetRoot, repoCwd: "/tmp",
      spawn: async (id) => {
        await writeFile(join(fleetRoot, "workers", id, "output", id === "research" ? "findings.md" : "summary.md"), "# Result\nbody");
        return { ok: true, turns: 2, tokens: 500 };
      },
    });
    expect(state.status).toBe("completed");
    const md = await writeReport({ spec, state, fleetRoot, repoCwd: "/tmp" });
    expect(md).toContain("smoke");
    expect(md).toContain("output/findings.md");
    const persisted = await readState(fleetRoot);
    expect(persisted.nodes.summarize.status).toBe("completed");
  });
});
