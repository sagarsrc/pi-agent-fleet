import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  commitWorktree,
  createWorktree,
  prepareIntegratorWorktree,
  removeWorktree,
} from "../src/worktree.js";

const execFileP = promisify(execFile);

async function initRepo(dir: string) {
  await execFileP("git", ["init"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileP("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

describe("worktree helpers", () => {
  it("creates a worktree on a deterministic branch", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
    await initRepo(base);
    const wt = await createWorktree({
      baseRepo: base,
      fleetName: "f",
      nodeId: "a",
      fleetRoot: join(base, ".fleet", "f-1"),
    });
    expect(wt).toContain("worktrees/a");
    const branches = await execFileP("git", ["branch", "--list", "fleet/f/a"], { cwd: base });
    expect(branches.stdout).toContain("fleet/f/a");
  });

  it("commits changes in a worktree", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
    await initRepo(base);
    const wt = await createWorktree({
      baseRepo: base,
      fleetName: "f",
      nodeId: "a",
      fleetRoot: join(base, ".fleet", "f-1"),
    });
    await writeFile(join(wt, "x.txt"), "hello", "utf-8");
    await commitWorktree({ worktreePath: wt, nodeId: "a", fleetName: "f", iteration: 1 });
    const log = await execFileP("git", ["log", "--oneline", "fleet/f/a"], { cwd: base });
    expect(log.stdout).toContain("fleet: f a iteration 1");
  });

  it("prepares an integrator worktree by merging branches in order", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
    await initRepo(base);

    const a = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "a", fleetRoot: join(base, ".fleet", "f-1") });
    const b = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "b", fleetRoot: join(base, ".fleet", "f-1") });

    await writeFile(join(a, "a.txt"), "A", "utf-8");
    await commitWorktree({ worktreePath: a, nodeId: "a", fleetName: "f", iteration: 1 });

    await writeFile(join(b, "b.txt"), "B", "utf-8");
    await commitWorktree({ worktreePath: b, nodeId: "b", fleetName: "f", iteration: 1 });

    const result = await prepareIntegratorWorktree({
      baseRepo: base,
      fleetName: "f",
      fleetRoot: join(base, ".fleet", "f-1"),
      branches: ["fleet/f/a", "fleet/f/b"],
    });

    expect(result.ok).toBe(true);
    const aContent = await execFileP("git", ["show", "HEAD:a.txt"], { cwd: result.path });
    const bContent = await execFileP("git", ["show", "HEAD:b.txt"], { cwd: result.path });
    expect(aContent.stdout.trim()).toBe("A");
    expect(bContent.stdout.trim()).toBe("B");
  });

  it("reports a merge conflict", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
    await initRepo(base);
    await writeFile(join(base, "shared.txt"), "base", "utf-8");
    await execFileP("git", ["add", "-A"], { cwd: base });
    await execFileP("git", ["commit", "-m", "base"], { cwd: base });

    const a = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "a", fleetRoot: join(base, ".fleet", "f-1") });
    const b = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "b", fleetRoot: join(base, ".fleet", "f-1") });

    await writeFile(join(a, "shared.txt"), "A", "utf-8");
    await commitWorktree({ worktreePath: a, nodeId: "a", fleetName: "f", iteration: 1 });

    await writeFile(join(b, "shared.txt"), "B", "utf-8");
    await commitWorktree({ worktreePath: b, nodeId: "b", fleetName: "f", iteration: 1 });

    const result = await prepareIntegratorWorktree({
      baseRepo: base,
      fleetName: "f",
      fleetRoot: join(base, ".fleet", "f-1"),
      branches: ["fleet/f/a", "fleet/f/b"],
    });

    expect(result.ok).toBe(false);
    expect(result.conflict).toContain("fleet/f/b");
  });

  it("removes a worktree", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet-wt-"));
    await initRepo(base);
    const wt = await createWorktree({ baseRepo: base, fleetName: "f", nodeId: "a", fleetRoot: join(base, ".fleet", "f-1") });
    await removeWorktree(wt, base);
    const list = await execFileP("git", ["worktree", "list"], { cwd: base });
    expect(list.stdout).not.toContain(wt);
  });

  it("recreates a worktree when the deterministic branch already exists", async () => {
    const repo = await mkdtemp(join(tmpdir(), "fleet-wt-"));
    await initRepo(repo);
    const fleetRoot = join(repo, ".fleet", "demo-20260101000000");
    await createWorktree({ baseRepo: repo, fleetName: "demo", nodeId: "n1", fleetRoot });
    await createWorktree({ baseRepo: repo, fleetName: "demo", nodeId: "n1", fleetRoot });
  });
});
