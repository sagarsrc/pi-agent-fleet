import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { contractFailureNote, verifyOutputs } from "./contracts.js";
import { archiveIteration, initFleetState, patchNode, relaunchResetIds, resetForIteration, snapshotIteration, writeState } from "./state.js";
import { TERMINAL_NODE_STATUSES } from "./types.js";
import type { FleetSpec, FleetState, IterationSnapshot, NodeState, Verdict, WorkerSpec } from "./types.js";
import { commitWorktree, createWorktree, prepareIntegratorWorktree } from "./worktree.js";

export type SpawnFn = (nodeId: string) => Promise<{ ok: boolean; turns: number; tokens: number; cost?: number; error?: string }>;

export interface RunFleetOpts {
  spec: FleetSpec;
  fleetRoot: string;
  baseRepo?: string;
  repoCwd: string | ((nodeId: string) => string);
  spawn: SpawnFn;
  onNodeChange?: (nodeId: string, s: NodeState) => void;
  onNodeAdded?: (worker: WorkerSpec) => void | Promise<void>;
  onNodeCompleted?: (nodeId: string) => Promise<string | undefined | void>;
  killSwitch?: { killed: boolean };
  pauseSwitch?: { paused: boolean };
  nodeKills?: ReadonlySet<string>;
  relaunchRequests?: Set<string>;
  resumeFrom?: FleetState;
  continuePass?: boolean;
  onIterationEnd?: (snap: IterationSnapshot) => void;
  prepareIteration?: (n: number, state: FleetState) => Promise<void>;
}

const FAILED: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed", "blocked"]);

function allNodesTerminal(state: FleetState, spec: FleetSpec): boolean {
  return spec.workers.every((w) => {
    const n = state.nodes[w.id];
    return !!n && TERMINAL_NODE_STATUSES.has(n.status);
  });
}

async function cleanReplayOutputs(spec: FleetSpec, fleetRoot: string): Promise<void> {
  for (const w of spec.workers) {
    if (w.iterate === false) continue;
    const outDir = join(fleetRoot, "workers", w.id, "output");
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
  }
}

export async function runFleet(opts: RunFleetOpts): Promise<FleetState> {
  const { spec, fleetRoot } = opts;
  const loop = spec.config.loop;

  let state: FleetState;
  if (opts.resumeFrom) {
    state = { ...opts.resumeFrom, paused: false, status: "running" };
    await writeState(fleetRoot, state);
    if (allNodesTerminal(state, spec) && !opts.continuePass) {
      state = resetForIteration(state, spec);
      await writeState(fleetRoot, state);
      await cleanReplayOutputs(spec, fleetRoot);
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

  const baseRepo = (): string | undefined =>
    opts.baseRepo ?? (typeof opts.repoCwd === "string" ? opts.repoCwd : undefined);

  function orderedWorktreeBranches(spec: FleetSpec): string[] {
    const ids = spec.workers.filter((w) => w.worktree).map((w) => w.id);
    const set = new Set(ids);
    const indeg = new Map(ids.map((id) => [id, 0]));
    const rev = new Map(ids.map((id) => [id, [] as string[]]));
    for (const w of spec.workers) {
      if (!set.has(w.id)) continue;
      for (const d of w.depends_on) {
        if (set.has(d)) {
          indeg.set(w.id, (indeg.get(w.id) ?? 0) + 1);
          rev.get(d)?.push(w.id);
        }
      }
    }
    const sorted: string[] = [];
    let current = ids.filter((id) => indeg.get(id) === 0);
    while (current.length > 0) {
      sorted.push(...current);
      const next: string[] = [];
      for (const id of current) {
        for (const m of rev.get(id) ?? []) {
          const v = (indeg.get(m) ?? 0) - 1;
          indeg.set(m, v);
          if (v === 0) next.push(m);
        }
      }
      current = next;
    }
    if (sorted.length !== ids.length) sorted.push(...ids.filter((id) => !sorted.includes(id)));
    return sorted.map((id) => `fleet/${spec.fleet_name}/${id}`);
  }

  const runPass = async (): Promise<void> => {
    while (true) {
      // apply queued relaunch requests (lost-wakeup fix, issue #1 bug 2)
      if (opts.relaunchRequests && opts.relaunchRequests.size > 0) {
        for (const id of [...opts.relaunchRequests]) {
          opts.relaunchRequests.delete(id);
          const n = state.nodes[id];
          if (!n || !FAILED.has(n.status)) continue;
          for (const rid of relaunchResetIds(spec, state, id)) {
            const rn = state.nodes[rid];
            if (!rn) continue;
            if (rid === id && !FAILED.has(rn.status)) continue;
            if (rid !== id && rn.status !== "blocked") continue;
            await patch(rid, {
              status: "pending",
              started_at: undefined,
              ended_at: undefined,
              turns: 0,
              tokens: 0,
              cost_usd_estimate: 0,
              produced_outputs: [],
              contract_result: undefined,
              status_note: undefined,
            });
          }
        }
      }
      // auto-initialize workers inserted into the spec after the run started
      for (const w of spec.workers) {
        if (!state.nodes[w.id]) {
          state = {
            ...state,
            nodes: {
              ...state.nodes,
              [w.id]: { status: "pending", turns: 0, tokens: 0, cost_usd_estimate: 0, produced_outputs: [] },
            },
          };
          await writeState(fleetRoot, state);
          await opts.onNodeAdded?.(w);
          opts.onNodeChange?.(w.id, state.nodes[w.id]);
        }
      }
      // block nodes whose deps failed
      for (const w of spec.workers) {
        const n = state.nodes[w.id];
        if (!n) continue;
        if (n.status !== "pending" && n.status !== "ready") continue;
        if (w.depends_on.some((d) => FAILED.has(state.nodes[d]?.status ?? ""))) {
          await patch(w.id, { status: "blocked", ended_at: new Date().toISOString() });
        }
      }
      if (opts.killSwitch?.killed) {
        for (const w of spec.workers) {
          const n = state.nodes[w.id];
          if (!n || !TERMINAL_NODE_STATUSES.has(n.status)) {
            await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
          }
        }
        break;
      }
      // honor kill requests for not-yet-running nodes (incl. blocked, issue #1 bug 3)
      for (const w of spec.workers) {
        const n = state.nodes[w.id];
        if (!n) continue;
        if (!opts.nodeKills?.has(w.id)) continue;
        if (n.status === "pending" || n.status === "ready" || n.status === "blocked") {
          await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
        }
      }
      // dispatch ready
      const activeCount = running.size;
      let slots = spec.config.max_concurrent - activeCount;
      for (const w of spec.workers) {
        if (slots <= 0) break;
        const n = state.nodes[w.id];
        if (!n) continue;
        if (n.status !== "pending" && n.status !== "ready") continue;
        if (opts.nodeKills?.has(w.id)) {
          await patch(w.id, { status: "killed", ended_at: new Date().toISOString() });
          continue;
        }
        const depsDone = w.depends_on.every((d) => state.nodes[d]?.status === "completed");
        if (!depsDone) continue;
        slots--;

        if (w.worktree) {
          const repo = baseRepo();
          if (!repo) {
            await patch(w.id, {
              status: "failed",
              ended_at: new Date().toISOString(),
              status_note: "worktree worker requires a baseRepo",
            });
            continue;
          }
          try {
            await createWorktree({
              baseRepo: repo,
              fleetName: spec.fleet_name,
              nodeId: w.id,
              fleetRoot,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await patch(w.id, {
              status: "failed",
              ended_at: new Date().toISOString(),
              status_note: `worktree creation failed: ${msg}`,
            });
            continue;
          }
        }

        if (w.id === "fleet-integrator") {
          const repo = baseRepo();
          if (!repo) {
            await patch(w.id, {
              status: "failed",
              ended_at: new Date().toISOString(),
              status_note: "integrator requires a baseRepo",
            });
            continue;
          }
          const prep = await prepareIntegratorWorktree({
            baseRepo: repo,
            fleetName: spec.fleet_name,
            fleetRoot,
            branches: orderedWorktreeBranches(spec),
          });
          if (!prep.ok) {
            await patch(w.id, {
              status: "failed",
              ended_at: new Date().toISOString(),
              status_note: prep.conflict,
            });
            continue;
          }
        }

        const dispatchMs = Date.now();
        await patch(w.id, { status: "running", started_at: new Date().toISOString() });
        const p = opts.spawn(w.id).then(async (res) => {
          if (opts.killSwitch?.killed) return;
          if (opts.nodeKills?.has(w.id)) {
            await patch(w.id, { status: "killed", ended_at: new Date().toISOString(), turns: res.turns, tokens: res.tokens, cost_usd_estimate: res.cost ?? 0 });
            return;
          }
          if (!res.ok) {
            await patch(w.id, { status: "failed", ended_at: new Date().toISOString(), turns: res.turns, tokens: res.tokens, cost_usd_estimate: res.cost ?? 0 });
            return;
          }
          if (w.worktree) {
            try {
              await commitWorktree({
                worktreePath: repoCwdFor(w.id),
                nodeId: w.id,
                fleetName: spec.fleet_name,
                iteration: state.iteration,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              await patch(w.id, {
                status: "failed",
                ended_at: new Date().toISOString(),
                turns: res.turns,
                tokens: res.tokens,
                cost_usd_estimate: res.cost ?? 0,
                status_note: `commit failed: ${msg}`,
              });
              return;
            }
          }
          const contract = await verifyOutputs({
            workerDir: `${fleetRoot}/workers/${w.id}`,
            repoCwd: repoCwdFor(w.id),
            outputs: w.outputs,
            notBeforeMs: dispatchMs,
          });
          const costUnknown = res.tokens > 0 && res.cost === 0;
          const costNote = costUnknown ? `cost unavailable: no pricing for model (${res.tokens} tokens used)` : undefined;
          await patch(w.id, {
            status: contract.ok ? "completed" : "contract_failed",
            ended_at: new Date().toISOString(),
            turns: res.turns,
            tokens: res.tokens,
            cost_usd_estimate: res.cost ?? 0,
            contract_result: contract,
            produced_outputs: contract.checks.filter((c) => c.ok || c.actualPath).map((c) => c.path),
            status_note: contract.ok ? costNote : [contractFailureNote(contract.checks), costNote].filter(Boolean).join(" · "),
          });
          if (contract.ok) {
            const note = await opts.onNodeCompleted?.(w.id);
            if (note) await patch(w.id, { status_note: note });
          }
        }).finally(() => running.delete(p));
        running.add(p);
      }
      if (running.size > 0) {
        await Promise.race(running);
      } else if (spec.workers.every((w) => {
        const n = state.nodes[w.id];
        return !!n && TERMINAL_NODE_STATUSES.has(n.status);
      })) {
        break;
      }
    }
    await Promise.allSettled([...running]);
  };

  const runPassUntilDrained = async () => {
    do {
      await runPass();
    } while (opts.relaunchRequests && opts.relaunchRequests.size > 0);
  };

  if (!loop) {
    await runPassUntilDrained();
    const anyFailed = spec.workers.some((w) =>
      ["failed", "contract_failed"].includes(state.nodes[w.id]?.status ?? ""));
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
      await cleanReplayOutputs(spec, fleetRoot);
    }

    await opts.prepareIteration?.(n, state);

    await runPassUntilDrained();

    let verdict: Verdict | null = null;
    let verdictBody: string | null = null;
    if (reviewerId) {
      const cr = state.nodes[reviewerId].contract_result;
      verdict = cr?.verdict ?? null;
      verdictBody = cr?.verdict_body ?? null;
    }

    state = snapshotIteration(state, verdict, verdictBody, spec);
    const snap = state.iterations[state.iterations.length - 1];
    opts.onIterationEnd?.(snap);
    await archiveIteration(fleetRoot, state.iteration, spec.workers.map((w) => w.id));

    if (opts.killSwitch?.killed) {
      state = { ...state, status: "killed" };
      await writeState(fleetRoot, state);
      return state;
    }

    const anyFailed = spec.workers.some((w) =>
      ["failed", "contract_failed"].includes(state.nodes[w.id]?.status ?? ""));
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
