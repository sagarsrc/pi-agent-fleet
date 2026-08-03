import { mkdtemp } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlannerPrompt, runFleetDesign, slugifyFleetName } from "../src/planner.js";

describe("slugifyFleetName", () => {
  it("slugifies requirements", () => {
    expect(slugifyFleetName("Research the EV Market!")).toBe("research-the-ev-market");
    expect(slugifyFleetName("---")).toBe("fleet");
    expect(slugifyFleetName("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("buildPlannerPrompt", () => {
  it("embeds requirements, paths, and the verdict contract", () => {
    const p = buildPlannerPrompt({ requirements: "build a thing", fleetName: "thing", plannerDir: "/d/planner" });
    expect(p).toContain("build a thing");
    expect(p).toContain('"fleet_name": "thing"' );
    expect(p).toContain("/d/planner/output/fleet.json");
    expect(p).toContain("verdict: lgtm");
    expect(p).toContain("Do NOT set \"model\" or \"effort\" fields");
  });
});

describe("runFleetDesign", () => {
  async function designRoot(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), "fleet-design-")), "design");
  }

  const goodFleet = {
    fleet_name: "t", type: "dag",
    workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
  };

  it("returns the parsed draft when the planner writes fleet.json", async () => {
    const root = await designRoot();
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: root, repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {
          await writeFile(join(root, "planner", "output", "fleet.json"), JSON.stringify(goodFleet), "utf-8");
          await writeFile(join(root, "planner", "output", "rationale.md"), "# Why\nbecause", "utf-8");
        },
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(true);
    expect((r.draft as { fleet_name: string }).fleet_name).toBe("t");
    expect(r.rationale).toContain("because");
  });

  it("errors when the planner writes no fleet.json", async () => {
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: await designRoot(), repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {},
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fleet.json");
  });

  it("errors when fleet.json is invalid JSON", async () => {
    const root = await designRoot();
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: root, repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {
          await writeFile(join(root, "planner", "output", "fleet.json"), "{nope", "utf-8");
        },
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
  });

  it("contains planner session failures", async () => {
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: await designRoot(), repoCwd: "/tmp",
      sessionFactory: async () => {
        throw new Error("no model");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no model");
  });
});

describe("draft sanitization", () => {
  it("strips model and effort fields from the planner draft", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "fleet-design-")), "design");
    const dirty = {
      fleet_name: "t", type: "dag",
      config: { model: "ghost/x", effort: "high", max_concurrent: 2 },
      workers: [
        { id: "a", type: "research", task: "t", depends_on: [], outputs: [], model: "ghost/y", effort: "low" },
        { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
      ],
    };
    const r = await runFleetDesign({
      requirements: "req", fleetName: "t", designRoot: root, repoCwd: "/tmp",
      sessionFactory: async () => ({
        prompt: async () => {
          await writeFile(join(root, "planner", "output", "fleet.json"), JSON.stringify(dirty), "utf-8");
        },
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      }),
    });
    expect(r.ok).toBe(true);
    const d = r.draft as { config: Record<string, unknown>; workers: Array<Record<string, unknown>> };
    expect(d.config.model).toBeUndefined();
    expect(d.config.effort).toBeUndefined();
    expect(d.config.max_concurrent).toBe(2);
    expect(d.workers[0].model).toBeUndefined();
    expect(d.workers[0].effort).toBeUndefined();
    expect(d.workers[0].id).toBe("a");
  });
});
