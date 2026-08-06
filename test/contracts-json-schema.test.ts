import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyOutputs } from "../src/contracts.js";

describe("verifyOutputs json schema", () => {
  it("fails json contract when required key missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "numbers.json"), JSON.stringify({ values: [1, 2] }), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { required_keys: ["values", "source"] } }] });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain("missing required key");
  });

  it("passes numeric values schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "numbers.json"), JSON.stringify({ values: [1, 2, 3] }), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { required_keys: ["values"], number_keys: ["values"] } }] });
    expect(r.ok).toBe(true);
  });

  it("fails when number_keys value is a string", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "numbers.json"), JSON.stringify({ result: "16" }), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { number_keys: ["result"] } }] });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain("must be a number or number[]");
  });

  it("fails when number_keys key is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "numbers.json"), JSON.stringify({ operation: "add" }), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { number_keys: ["result"] } }] });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain("must be a number or number[]");
  });

  it("fails when schema present but json is not an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "numbers.json"), JSON.stringify([1, 2, 3]), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/numbers.json", kind: "json", required: true, schema: { required_keys: ["values"] } }] });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain("requires an object");
  });

  it("fails required_keys for prototype-chain keys like toString", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "data.json"), JSON.stringify({ values: [1] }), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/data.json", kind: "json", required: true, schema: { required_keys: ["toString"] } }] });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain('missing required key "toString"');
  });

  it("still passes plain json without schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-json-"));
    await mkdir(join(dir, "output"), { recursive: true });
    await writeFile(join(dir, "output", "data.json"), JSON.stringify([1, 2, 3]), "utf-8");
    const r = await verifyOutputs({ workerDir: dir, repoCwd: dir, outputs: [{ path: "output/data.json", kind: "json", required: true }] });
    expect(r.ok).toBe(true);
  });
});
