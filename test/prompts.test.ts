import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../src/prompts.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "research", type: "research", task: "Research auth", depends_on: [],
      outputs: [{ path: "output/findings.md", kind: "markdown", required: true }] },
    { id: "build", type: "code-run", task: "Build login", depends_on: ["research"],
      outputs: [{ path: "src/auth/login.ts", kind: "file-exists", required: true }] },
  ],
};

describe("buildWorkerPrompt", () => {
  const state = initFleetState(spec);
  it("gives upstream node its obligations and downstream awareness", () => {
    const p = buildWorkerPrompt({ spec, state, workerId: "research", fleetRoot: "/f" });
    expect(p).toContain("# Fleet worker: research");
    expect(p).toContain("Research auth");
    expect(p).toContain("build");
    expect(p).toContain("output/findings.md");
    expect(p).toContain("/f/workers/research/output/");
  });
  it("gives downstream node resolved upstream paths", () => {
    const p = buildWorkerPrompt({ spec, state, workerId: "build", fleetRoot: "/f" });
    expect(p).toContain("/f/workers/research/output/findings.md");
    expect(p).toContain("src/auth/login.ts");
    expect(p).toContain("Write code changes directly at their repo paths");
    expect(p).not.toContain("/f/workers/build/output/ — use absolute paths");
  });
  it("prepends an autonomy contract before the task section", () => {
    const p = buildWorkerPrompt({ spec, state, workerId: "research", fleetRoot: "/f" });
    const auto = p.indexOf("## Autonomy contract");
    const task = p.indexOf("## Task");
    expect(auto).toBeGreaterThanOrEqual(0);
    expect(task).toBeGreaterThan(auto);
  });

  it("autonomy contract forbids approval gates and open questions", () => {
    const p = buildWorkerPrompt({ spec, state, workerId: "research", fleetRoot: "/f" });
    expect(p).toContain("PRE-APPROVED");
    expect(p).toContain("no human");
    expect(p).toContain("Do not end your turn with a question");
  });

  it("documents the node-requests sideband contract", () => {
    const prompt = buildWorkerPrompt({ spec, state, workerId: "research", fleetRoot: "/fr" });
    expect(prompt).toContain("node-requests.json");
    expect(prompt).toContain("Requesting additional nodes");
  });
});
