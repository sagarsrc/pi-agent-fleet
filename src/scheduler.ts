import { verifyOutputs } from "./contracts.js";
import { initFleetState, patchNode, writeState } from "./state.js";
import { TERMINAL_NODE_STATUSES } from "./types.js";
import type { FleetSpec, FleetState, NodeState } from "./types.js";

export type SpawnFn = (nodeId: string) => Promise<{ ok: boolean; turns: number; tokens: number; error?: string }>;

export interface RunFleetOpts {
  spec: FleetSpec;
  fleetRoot: string;
  repoCwd: string;
  spawn: SpawnFn;
  onNodeChange?: (nodeId: string, s: NodeState) => void;
  killSwitch?: { killed: boolean };
}

const FAILED: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed", "blocked"]);

export async function runFleet(opts: RunFleetOpts): Promise<FleetState> {
  const { spec, fleetRoot } = opts;
  let state = initFleetState(spec);
  state = { ...state, status: "running" };
  await writeState(fleetRoot, state);

  const patch = async (id: string, p: Partial<NodeState>) => {
    state = patchNode(fleetRoot, state, id, p);
    await writeState(fleetRoot, state);
    opts.onNodeChange?.(id, state.nodes[id]);
  };

  const running = new Set<Promise<void>>();

  while (true) {
    // block nodes whose deps failed
    for (const w of spec.workers) {
      const n = state.nodes[w.id];
      if (n.status !== "pending" && n.status !== "ready") continue;
      if (w.depends_on.some((d) => FAILED.has(state.nodes[d].status))) {
        await patch(w.id, { status: "blocked", ended_at: new Date().toISOString() });
      }
    }
    if (opts.killSwitch?.killed) {
      for (const w of spec.workers) {
        const n = state.nodes[w.id];
        if (!TERMINAL_NODE_STATUSES.has(n.status)) {
          await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
        }
      }
      break;
    }
    // dispatch ready
    const activeCount = running.size;
    let slots = spec.config.max_concurrent - activeCount;
    for (const w of spec.workers) {
      if (slots <= 0) break;
      const n = state.nodes[w.id];
      if (n.status !== "pending" && n.status !== "ready") continue;
      const depsDone = w.depends_on.every((d) => state.nodes[d].status === "completed");
      if (!depsDone) continue;
      slots--;
      await patch(w.id, { status: "running", started_at: new Date().toISOString() });
      const p = opts.spawn(w.id).then(async (res) => {
        if (!res.ok) {
          await patch(w.id, { status: "failed", ended_at: new Date().toISOString(), turns: res.turns, tokens: res.tokens });
          return;
        }
        const contract = await verifyOutputs({
          workerDir: `${fleetRoot}/workers/${w.id}`,
          repoCwd: opts.repoCwd,
          outputs: w.outputs,
        });
        await patch(w.id, {
          status: contract.ok ? "completed" : "contract_failed",
          ended_at: new Date().toISOString(),
          turns: res.turns,
          tokens: res.tokens,
          contract_result: contract,
          produced_outputs: contract.checks.filter((c) => c.ok).map((c) => c.path),
        });
      }).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size > 0) {
      await Promise.race(running);
    } else if (spec.workers.every((w) => TERMINAL_NODE_STATUSES.has(state.nodes[w.id].status))) {
      break;
    }
  }

  await Promise.allSettled([...running]);
  const anyFailed = spec.workers.some((w) =>
    ["failed", "contract_failed"].includes(state.nodes[w.id].status));
  const finalStatus = opts.killSwitch?.killed ? "killed" : anyFailed ? "failed" : "completed";
  state = { ...state, status: finalStatus };
  await writeState(fleetRoot, state);
  return state;
}
