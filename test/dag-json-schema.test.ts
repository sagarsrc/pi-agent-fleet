import { describe, expect, it } from "vitest";
import { validateFleetSpec } from "../src/dag.js";

function specWithOutput(output: Record<string, unknown>) {
  return {
    fleet_name: "t-fleet",
    type: "dag",
    config: { max_concurrent: 1 },
    workers: [
      { id: "a", type: "write", task: "t", depends_on: [], outputs: [output] },
    ],
  };
}

describe("validateFleetSpec json output schema", () => {
  it("accepts valid schema on json output", () => {
    const r = validateFleetSpec(specWithOutput({
      path: "output/numbers.json", kind: "json", required: true,
      schema: { required_keys: ["values"], number_keys: ["values"] },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.workers[0].outputs[0].schema).toEqual({ required_keys: ["values"], number_keys: ["values"] });
    }
  });

  it("rejects schema on non-json kind", () => {
    const r = validateFleetSpec(specWithOutput({
      path: "output/notes.md", kind: "markdown", required: true,
      schema: { required_keys: ["values"] },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("schema"))).toBe(true);
  });

  it("rejects schema that is not an object", () => {
    const r = validateFleetSpec(specWithOutput({
      path: "output/numbers.json", kind: "json", required: true,
      schema: "required_keys",
    }));
    expect(r.ok).toBe(false);
  });

  it("rejects required_keys that is not an array of non-empty strings", () => {
    for (const required_keys of ["values", [""], [1], [{}]]) {
      const r = validateFleetSpec(specWithOutput({
        path: "output/numbers.json", kind: "json", required: true,
        schema: { required_keys },
      }));
      expect(r.ok).toBe(false);
    }
  });

  it("rejects number_keys that is not an array of non-empty strings", () => {
    const r = validateFleetSpec(specWithOutput({
      path: "output/numbers.json", kind: "json", required: true,
      schema: { number_keys: [42] },
    }));
    expect(r.ok).toBe(false);
  });

  it("preserves outputs without schema unchanged", () => {
    const r = validateFleetSpec(specWithOutput({ path: "output/notes.md", kind: "markdown", required: true }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.workers[0].outputs[0].schema).toBeUndefined();
  });
});
