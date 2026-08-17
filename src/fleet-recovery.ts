import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveFleet } from "./controller.js";
import { initFleetState, readState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";

export interface FleetRootInfo {
  name: string;
  root: string;
  status: string;
  created_at: string;
}

export async function readDiskFleet(fleetRoot: string): Promise<ActiveFleet> {
  const spec = JSON.parse(await readFile(join(fleetRoot, "fleet.json"), "utf-8")) as FleetSpec;
  // Bare fleet.json-only root (e.g. hand-copied spec, never planned/launched):
  // synthesize a fresh pending state so the canvas can still render the DAG.
  let state: FleetState;
  try {
    state = await readState(fleetRoot);
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code !== "ENOENT") throw e;
    state = initFleetState(spec);
  }
  return {
    spec,
    fleetRoot,
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: false,
    sessions: new Map(),
    killedNodes: new Set(),
    relaunchRequests: new Set(),
  };
}

export async function listFleetRoots(cwd: string): Promise<FleetRootInfo[]> {
  const base = join(cwd, ".fleet");
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }
  const out: FleetRootInfo[] = [];
  for (const name of entries) {
    const root = join(base, name);
    try {
      const s = await stat(join(root, "fleet.json"));
      if (!s.isFile()) continue;
      const state = JSON.parse(await readFile(join(root, "state.json"), "utf-8")) as Partial<FleetState>;
      out.push({
        name,
        root,
        status: typeof state.status === "string" ? state.status : "unknown",
        created_at: typeof state.created_at === "string" ? state.created_at : new Date(s.mtimeMs).toISOString(),
      });
    } catch {
      // not a fleet root (no fleet.json) or unreadable state — skip or mark unknown
      try {
        await stat(join(root, "fleet.json"));
        out.push({ name, root, status: "unknown", created_at: "" });
      } catch {
        // not a fleet root
      }
    }
  }
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

export async function recoverLatestFleet(cwd: string): Promise<ActiveFleet | undefined> {
  const roots = await listFleetRoots(cwd);
  const latest = roots.find((r) => r.status !== "unknown") ?? roots[0];
  if (!latest) return undefined;
  try {
    return await readDiskFleet(latest.root);
  } catch {
    return undefined;
  }
}
