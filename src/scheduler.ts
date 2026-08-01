import { verifyOutputs } from "./contracts.js";
import { archiveIteration, initFleetState, patchNode, resetForIteration, snapshotIteration, writeState } from "./state.js";
import { TERMINAL_NODE_STATUSES } from "./types.js";
import type { FleetSpec, FleetState, IterationSnapshot, NodeState, Verdict } from "./types.js";

export type SpawnFn = (nodeId: string) => Promise<{ ok: boolean; turns: number; tokens: number; error?: string }>;

export interface RunFleetOpts {
  spec: FleetSpec;
  fleetRoot: string;
  repoCwd: string | ((nodeId: string) => string);
  spawn: SpawnFn;
  onNodeChange?: (nodeId: string, s: NodeState) => void;
  killSwitch?: { killed: boolean };
  pauseSwitch?: { paused: boolean };
  resumeFrom?: FleetState;
  onIterationEnd?: (snap: IterationSnapshot) => void;
  prepareIteration?: (n: number, state: FleetState) => Promise<void>;
}

const FAILED: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed", "blocked"]);

function allNodesTerminal(state: FleetState, spec: FleetSpec): boolean {
  return spec.workers.every((w) => TERMINAL_NODE_STATUSES.has(state.nodes[w.id].status));
}

export async function runFleet(opts: RunFleetOpts): Promise<FleetState> {
  const { spec, fleetRoot } = opts;
  const loop = spec.config.loop;

  let state: FleetState;
  if (opts.resumeFrom) {
    state = { ...opts.resumeFrom, paused: false, status: "running" };
    await writeState(fleetRoot, state);
    if (allNodesTerminal(state, spec)) {
      state = resetForIteration(state, spec);
      await writeState(fleetRoot, state);
    }
  } else {
    state = initFleetState(spec);
    state = { ...state, status: "running" };
    await writeState(fleetRoot, state);
  }

  const patch = async (id: string, p: Partial<NodeState>) => {
    state = patchNode(fleetRoot, state, id, p);
    await writeState(fleetRoot, state);
    opts.onNodeChange?.(id, state.nodes[id]);
  };

  const running = new Set<Promise<void>>();

  const repoCwdFor = (nodeId: string): string =>
    typeof opts.repoCwd === "function" ? opts.repoCwd(nodeId) : opts.repoCwd;

  const runPass = async (): Promise<void> => {
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
          if (opts.killSwitch?.killed) return;
          if (!res.ok) {
            await patch(w.id, { status: "failed", ended_at: new Date().toISOString(), turns: res.turns, tokens: res.tokens });
            return;
          }
          const contract = await verifyOutputs({
            workerDir: `${fleetRoot}/workers/${w.id}`,
            repoCwd: repoCwdFor(w.id),
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
  };

  if (!loop) {
    await runPass();
    const anyFailed = spec.workers.some((w) =>
      ["failed", "contract_failed"].includes(state.nodes[w.id].status));
    const finalStatus = opts.killSwitch?.killed ? "killed" : anyFailed ? "failed" : "completed";
    state = { ...state, status: finalStatus };
    await writeState(fleetRoot, state);
    return state;
  }

  const maxIterations = loop.max_iterations;
  const reviewerId = loop.gate === "reviewer"
    ? spec.workers.find((w) => w.outputs.some((o) => o.kind === "verdict"))?.id
    : undefined;

  const initialIteration = state.iteration;
  for (let n = state.iteration; n <= maxIterations; n++) {
    if (opts.pauseSwitch?.paused || state.paused) {
      state = { ...state, status: "paused", paused: true };
      await writeState(fleetRoot, state);
      return state;
    }

    if (n > initialIteration) {
      state = resetForIteration(state, spec);
      await writeState(fleetRoot, state);
    }

    await opts.prepareIteration?.(n, state);

    await runPass();

    let verdict: Verdict | null = null;
    let verdictBody: string | null = null;
    if (reviewerId) {
      const cr = state.nodes[reviewerId].contract_result;
      verdict = cr?.verdict ?? null;
      verdictBody = cr?.verdict_body ?? null;
    }

    state = snapshotIteration(state, verdict, verdictBody);
    const snap = state.iterations[state.iterations.length - 1];
    opts.onIterationEnd?.(snap);
    await archiveIteration(fleetRoot, state.iteration, spec.workers.map((w) => w.id));

    if (opts.killSwitch?.killed) {
      state = { ...state, status: "killed" };
      await writeState(fleetRoot, state);
      return state;
    }

    const anyFailed = spec.workers.some((w) =>
      ["failed", "contract_failed"].includes(state.nodes[w.id].status));
    if (anyFailed) {
      state = { ...state, status: "failed" };
      await writeState(fleetRoot, state);
      return state;
    }

    if (loop.gate === "reviewer") {
      const v = verdict;
      if (v === "lgtm") {
        const streak = state.lgtm_streak + 1;
        if (streak >= loop.lgtm_count) {
          state = { ...state, status: "completed", lgtm_streak: streak };
          await writeState(fleetRoot, state);
          return state;
        }
        state = { ...state, lgtm_streak: streak };
        await writeState(fleetRoot, state);
        continue;
      }
      if (v === "iterate") {
        state = { ...state, lgtm_streak: 0 };
        await writeState(fleetRoot, state);
        continue;
      }
      if (v === "escalate") {
        state = { ...state, status: "paused", paused: true };
        await writeState(fleetRoot, state);
        return state;
      }
      // Reviewer completed without a readable verdict; treat as fleet failure.
      state = { ...state, status: "failed" };
      await writeState(fleetRoot, state);
      return state;
    }

    // gate: "none" — continue to next iteration until cap.
  }

  state = { ...state, status: "failed" };
  await writeState(fleetRoot, state);
  return state;
}
