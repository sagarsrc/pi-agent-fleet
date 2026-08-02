import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureFleetGitignore, fleetRootFor, isInsideGitRepo, writePlanFiles } from "../src/fleet-store.js";
import { initFleetState } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t",
  type: "dag",
  config: { max_concurrent: 2, model: "m" },
  workers: [{ id: "a", type: "research", task: "t", depends_on: [], outputs: [] }],
};

describe("fleetRootFor", () => {
  it("joins cwd/.fleet/name-timestamp", () => {
    const r = fleetRootFor("/repo", "my-fleet");
    expect(r.startsWith("/repo/.fleet/my-fleet-")).toBe(true);
  });
});

describe("isInsideGitRepo", () => {
  it("true when an ancestor has .git, false otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-store-"));
    expect(await isInsideGitRepo(dir)).toBe(false);
    await mkdir(join(dir, ".git"));
    expect(await isInsideGitRepo(join(dir, "sub", "deep"))).toBe(true);
  });
});

describe("ensureFleetGitignore", () => {
  it("creates gitignore with * and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-store-"));
    await ensureFleetGitignore(dir);
    const p = join(dir, ".fleet", ".gitignore");
    expect((await readFile(p, "utf-8")).trim()).toBe("*");
    await ensureFleetGitignore(dir);
    expect((await readFile(p, "utf-8")).trim()).toBe("*");
  });

  it("preserves existing content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-store-"));
    await mkdir(join(dir, ".fleet"), { recursive: true });
    const p = join(dir, ".fleet", ".gitignore");
    await writeFile(p, "keep-me\n", "utf-8");
    await ensureFleetGitignore(dir);
    const c = await readFile(p, "utf-8");
    expect(c).toContain("keep-me");
    expect(c).toContain("*");
  });
});

describe("writePlanFiles", () => {
  it("writes fleet.json, state.json, and worker output dirs", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "fleet-store-")), "fr");
    await writePlanFiles(root, spec, initFleetState(spec));
    const fleet = JSON.parse(await readFile(join(root, "fleet.json"), "utf-8"));
    expect(fleet.fleet_name).toBe("t");
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf-8"));
    expect(state.nodes.a.status).toBe("pending");
    const out = await stat(join(root, "workers", "a", "output"));
    expect(out.isDirectory()).toBe(true);
  });
});
