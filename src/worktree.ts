import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CreateWorktreeOpts {
  baseRepo: string;
  fleetName: string;
  nodeId: string;
  fleetRoot: string;
}

export async function createWorktree(opts: CreateWorktreeOpts): Promise<string> {
  const path = join(opts.fleetRoot, "worktrees", opts.nodeId);
  const branch = `fleet/${opts.fleetName}/${opts.nodeId}`;
  await mkdir(path, { recursive: true });
  await removeWorktree(path, opts.baseRepo);
  await removeBranch(opts.baseRepo, branch);
  await execFileP("git", ["worktree", "add", "-b", branch, path], { cwd: opts.baseRepo });
  return path;
}

export interface CommitWorktreeOpts {
  worktreePath: string;
  nodeId: string;
  fleetName: string;
  iteration: number;
}

export async function commitWorktree(opts: CommitWorktreeOpts): Promise<void> {
  await execFileP("git", ["add", "-A"], { cwd: opts.worktreePath });
  try {
    await execFileP(
      "git",
      ["commit", "-m", `fleet: ${opts.fleetName} ${opts.nodeId} iteration ${opts.iteration}`],
      { cwd: opts.worktreePath },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("nothing to commit")) return;
    throw e;
  }
}

export interface PrepareIntegratorOpts {
  baseRepo: string;
  fleetName: string;
  fleetRoot: string;
  branches: string[];
}

export async function prepareIntegratorWorktree(
  opts: PrepareIntegratorOpts,
): Promise<{ path: string; ok: boolean; conflict?: string }> {
  const path = join(opts.fleetRoot, "worktrees", "fleet-integrator");
  await removeWorktree(path, opts.baseRepo);
  await removeBranch(opts.baseRepo, `fleet/${opts.fleetName}/fleet-integrator`);
  await mkdir(path, { recursive: true });
  await execFileP("git", ["worktree", "add", "-b", `fleet/${opts.fleetName}/fleet-integrator`, path], {
    cwd: opts.baseRepo,
  });
  for (const branch of opts.branches) {
    try {
      await execFileP("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: path });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { path, ok: false, conflict: `merge ${branch} failed: ${msg}` };
    }
  }
  return { path, ok: true };
}

export async function removeWorktree(path: string, baseRepo: string): Promise<void> {
  await execFileP("git", ["worktree", "remove", "--force", path], { cwd: baseRepo }).catch(() => {});
}

export async function removeBranch(baseRepo: string, branch: string): Promise<void> {
  await execFileP("git", ["branch", "-D", branch], { cwd: baseRepo }).catch(() => {});
}
