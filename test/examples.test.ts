import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateFleetSpec } from "../src/dag.js";

describe("examples", () => {
  it("examples/json-number-pipeline.json is a valid fleet spec", async () => {
    const raw = await readFile(join(import.meta.dirname, "..", "examples", "json-number-pipeline.json"), "utf-8");
    const r = validateFleetSpec(JSON.parse(raw));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.fleet_name).toBe("json-number-pipeline");
      expect(r.spec.workers.map((w) => w.id)).toEqual(["write-numbers", "add-numbers", "subtract-numbers", "synthesize"]);
      expect(r.layers).toEqual([["write-numbers"], ["add-numbers", "subtract-numbers"], ["synthesize"]]);
    }
  });
});
