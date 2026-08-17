import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyOutputs } from "../src/contracts.js";

async function setup(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "fleet-test-"));
  const workerDir = join(root, "worker");
  const repoCwd = join(root, "repo");
  await mkdir(join(workerDir, "output"), { recursive: true });
  await mkdir(join(repoCwd, "src"), { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    const full = p.startsWith("output/") ? join(workerDir, p) : join(repoCwd, p);
    await writeFile(full, content);
  }
  return { workerDir, repoCwd };
}

describe("verifyOutputs", () => {
  it("passes valid markdown in output/", async () => {
    const { workerDir, repoCwd } = await setup({ "output/findings.md": "# Findings\nbody" });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [{ path: "output/findings.md", kind: "markdown", required: true }] });
    expect(r.ok).toBe(true);
  });
  it("passes markdown with leading Status metadata before heading", async () => {
    const { workerDir, repoCwd } = await setup({ "output/review.md": "Status: approved\n\n# Review\nbody" });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [{ path: "output/review.md", kind: "markdown", required: true }] });
    expect(r.ok).toBe(true);
  });
  it("fails markdown with leading Status but no heading", async () => {
    const { workerDir, repoCwd } = await setup({ "output/review.md": "Status: approved\n\nno heading" });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [{ path: "output/review.md", kind: "markdown", required: true }] });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain("no markdown heading after leading metadata line");
  });
  it("fails file-exists for a repo-relative file untouched since notBeforeMs", async () => {
    const { workerDir, repoCwd } = await setup({ "src/login.ts": "export const x = 1;" });
    const full = join(repoCwd, "src/login.ts");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(full, old, old);
    const r = await verifyOutputs({
      workerDir,
      repoCwd,
      notBeforeMs: Date.now(),
      outputs: [{ path: "src/login.ts", kind: "file-exists", required: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.checks[0].error).toContain("not modified");
  });
  it("passes file-exists for a repo-relative file modified after notBeforeMs", async () => {
    const { workerDir, repoCwd } = await setup({ "src/login.ts": "export const x = 1;" });
    const full = join(repoCwd, "src/login.ts");
    const notBeforeMs = Date.now() - 60 * 60 * 1000;
    const now = new Date();
    await utimes(full, now, now);
    const r = await verifyOutputs({
      workerDir,
      repoCwd,
      notBeforeMs,
      outputs: [{ path: "src/login.ts", kind: "file-exists", required: true }],
    });
    expect(r.ok).toBe(true);
  });
  it("ignores notBeforeMs for output/ paths", async () => {
    const { workerDir, repoCwd } = await setup({ "output/fresh.md": "hello" });
    const full = join(workerDir, "output/fresh.md");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(full, old, old);
    const r = await verifyOutputs({
      workerDir,
      repoCwd,
      notBeforeMs: Date.now(),
      outputs: [{ path: "output/fresh.md", kind: "file-exists", required: true }],
    });
    expect(r.ok).toBe(true);
  });
  it("verdict requires verdict line and body", async () => {
    const good = await setup({ "output/review.md": "verdict: iterate\n\n## builder\n1. fix src/a.ts line 3" });
    expect((await verifyOutputs({ workerDir: good.workerDir, repoCwd: good.repoCwd, outputs: [{ path: "output/review.md", kind: "verdict", required: true }] })).ok).toBe(true);
    const noBody = await setup({ "output/review.md": "verdict: lgtm\n" });
    expect((await verifyOutputs({ workerDir: noBody.workerDir, repoCwd: noBody.repoCwd, outputs: [{ path: "output/review.md", kind: "verdict", required: true }] })).ok).toBe(false);
  });
  it("json must parse; optional missing does not fail", async () => {
    const { workerDir, repoCwd } = await setup({ "output/data.json": '{"a":1}' });
    const r = await verifyOutputs({ workerDir, repoCwd, outputs: [
      { path: "output/data.json", kind: "json", required: true },
      { path: "output/missing.md", kind: "markdown", required: false },
    ] });
    expect(r.ok).toBe(true);
    expect(r.checks[1].ok).toBe(false);
  });
});
