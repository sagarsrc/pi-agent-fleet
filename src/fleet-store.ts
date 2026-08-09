import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildWorkerPrompt } from "./prompts.js";
import { writeState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";

export function fleetRootFor(cwd: string, name: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return join(cwd, ".fleet", `${name}-${ts}`);
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  let dir = cwd;
  while (true) {
    try {
      const s = await stat(join(dir, ".git"));
      if (s.isFile() || s.isDirectory()) return true;
    } catch {
      // any stat failure (ENOENT, EACCES, etc.) is treated as not-found
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export async function ensureFleetGitignore(cwd: string): Promise<void> {
  const dir = join(cwd, ".fleet");
  const gitignore = join(dir, ".gitignore");
  await mkdir(dir, { recursive: true });
  let current = "";
  try {
    current = await readFile(gitignore, "utf-8");
  } catch {
    // created below
  }
  if (!current.split(/\r?\n/).includes("*")) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await writeFile(gitignore, `${current}${prefix}*\n`, "utf-8");
  }
}

export async function writePlanFiles(fleetRoot: string, spec: FleetSpec, state: FleetState): Promise<void> {
  await mkdir(fleetRoot, { recursive: true });
  await Promise.all(spec.workers.map((w) => mkdir(join(fleetRoot, "workers", w.id, "output"), { recursive: true })));
  await writeFile(join(fleetRoot, "fleet.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
  await writeState(fleetRoot, state);
}

export async function persistFleetJson(fleet: { fleetRoot: string; spec: FleetSpec }): Promise<void> {
  const path = join(fleet.fleetRoot, "fleet.json");
  const tmp = join(fleet.fleetRoot, `.fleet.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, `${JSON.stringify(fleet.spec, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

export async function writeWorkerPrompts(fleet: { spec: FleetSpec; state: FleetState; fleetRoot: string }): Promise<void> {
  await Promise.all(fleet.spec.workers.map(async (w) => {
    const dir = join(fleet.fleetRoot, "workers", w.id);
    await mkdir(dir, { recursive: true });
    const prompt = buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: w.id, fleetRoot: fleet.fleetRoot });
    await writeFile(join(dir, "prompt.md"), prompt, "utf-8");
  }));
}
