import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyOutputs } from "../src/contracts.js";

async function fixture(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-c-"));
  await mkdir(join(dir, "output"), { recursive: true });
  await writeFile(join(dir, "output", "review.md"), content, "utf-8");
  return dir;
}

describe("verdict extraction", () => {
  it("extracts verdict and body", async () => {
    const dir = await fixture("verdict: iterate\n\n## builder-a\n1. fix the thing\n");
    const r = await verifyOutputs({
      workerDir: dir,
      repoCwd: dir,
      outputs: [{ path: "output/review.md", kind: "verdict", required: true }],
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("iterate");
    expect(r.verdict_body).toBe("## builder-a\n1. fix the thing");
  });

  it("verdict-only file fails with no verdict extracted", async () => {
    const dir = await fixture("verdict: lgtm\n");
    const r = await verifyOutputs({
      workerDir: dir,
      repoCwd: dir,
      outputs: [{ path: "output/review.md", kind: "verdict", required: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBeUndefined();
    expect(r.verdict_body).toBeUndefined();
  });

  it("non-verdict fleets keep verdict fields undefined", async () => {
    const dir = await fixture("# Findings\nbody\n");
    const r = await verifyOutputs({
      workerDir: dir,
      repoCwd: dir,
      outputs: [{ path: "output/review.md", kind: "markdown", required: true }],
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBeUndefined();
    expect(r.verdict_body).toBeUndefined();
  });

  it("accepts case-insensitive verdict keyword and value", async () => {
    const dir = await fixture("Verdict: LGTM\n\nbody\n");
    const r = await verifyOutputs({
      workerDir: dir,
      repoCwd: dir,
      outputs: [{ path: "output/review.md", kind: "verdict", required: true }],
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("lgtm");
    expect(r.verdict_body).toBe("body");
  });

  it("normalizes mixed-case verdict value", async () => {
    const dir = await fixture("VERDICT: Iterate\n\nbody\n");
    const r = await verifyOutputs({
      workerDir: dir,
      repoCwd: dir,
      outputs: [{ path: "output/review.md", kind: "verdict", required: true }],
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("iterate");
    expect(r.verdict_body).toBe("body");
  });
});
