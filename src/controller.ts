import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { writeWorkerPrompts } from "./fleet-store.js";
import { resolveModelReference } from "./model-resolution.js";
import { writeReport } from "./report.js";
import { runWorker, sessionFactoryForModel, workerWithResolvedModel } from "./runner.js";
import { runFleet } from "./scheduler.js";
import { patchNode, readState, writeState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";
import { buildWidgetLines } from "./ui.js";
import { dagNeedsFileFallback, renderDag } from "./viz.js";

export interface ActiveFleet {
  spec: FleetSpec;
  fleetRoot: string;
  state: FleetState;
  killSwitch: { killed: boolean };
  pauseSwitch: { paused: boolean };
  running: boolean;
  costWarned?: boolean;
}

export interface ActiveFleetCell {
  current: ActiveFleet | undefined;
}

export const activeFleet: ActiveFleetCell = { current: undefined };

export function updateWidget(ctx: ExtensionContext, fleet: ActiveFleet, spinnerFrame?: number): void {
  if (ctx.hasUI) ctx.ui.setWidget("fleet", buildWidgetLines(fleet.spec, fleet.state, { spinnerFrame }));
}

export function startSpinner(ctx: ExtensionContext, fleet: ActiveFleet, intervalMs = 150): () => void {
  if (!ctx.hasUI) return () => {};
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    updateWidget(ctx, fleet, frame);
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export async function currentState(fleet: ActiveFleet): Promise<FleetState> {
  if (fleet.running) return fleet.state;
  try {
    fleet.state = await readState(fleet.fleetRoot);
  } catch {
    // keep in-memory state
  }
  return fleet.state;
}

export async function statusText(fleet: ActiveFleet): Promise<string> {
  const state = await currentState(fleet);
  return renderDag(fleet.spec, state);
}

export async function dagPreview(spec: FleetSpec, state: FleetState | undefined, fleetRoot: string): Promise<string> {
  const out = renderDag(spec, state);
  const width = process.stdout.columns ?? 120;
  if (dagNeedsFileFallback(spec, width)) {
    const p = join(fleetRoot, "dag.txt");
    await writeFile(p, out, "utf-8");
    return `${out}\n\nDAG preview saved: ${p}`;
  }
  return out;
}

export async function startLoop(fleet: ActiveFleet, ctx: ExtensionContext, resume = false, continuePass = false): Promise<void> {
  let resumeFrom: FleetState | undefined;
  try {
    if (continuePass) {
      resumeFrom = fleet.state;
    } else if (resume) {
      resumeFrom = await readState(fleet.fleetRoot);
    }
  } catch (err: unknown) {
    fleet.running = false;
    const error = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`fleet failed: ${error}`, "error");
    return;
  }

  fleet.running = true;
  fleet.costWarned = false;
  const stopSpinner = startSpinner(ctx, fleet);
  updateWidget(ctx, fleet);

  const checkCostWarning = () => {
    const warn = fleet.spec.config.warn_cost_usd;
    if (!warn || fleet.costWarned) return;
    const cost = fleet.state.cost_usd_estimate;
    if (cost >= warn) {
      fleet.costWarned = true;
      if (ctx.hasUI) ctx.ui.notify(`fleet cost warning: $${cost.toFixed(4)} >= $${warn}`, "warning");
    }
  };

  const spawn = async (nodeId: string) => {
    try {
      const worker = fleet.spec.workers.find((w) => w.id === nodeId);
      if (!worker) return { ok: false, turns: 0, tokens: 0, error: `unknown worker "${nodeId}"` };

      let resolvedModel: Model<Api> | undefined;
      let modelNote: string | undefined;
      if (worker.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, worker.model);
        if (!resolved.ok) return { ok: false, turns: 0, tokens: 0, error: resolved.error };
        resolvedModel = resolved.model;
      } else if (fleet.spec.config.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, fleet.spec.config.model);
        if (resolved.ok) resolvedModel = resolved.model;
        else modelNote = `config.model "${fleet.spec.config.model}" not found, using session default`;
      }
      if (modelNote) {
        fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: modelNote });
        updateWidget(ctx, fleet);
      }

      const prompt = await readFile(join(fleet.fleetRoot, "workers", nodeId, "prompt.md"), "utf-8");
      const sessionDir = join(fleet.fleetRoot, "workers", nodeId);
      const effort = worker.effort ?? fleet.spec.config.effort ?? "medium";
      return await runWorker({
        nodeId,
        worker: workerWithResolvedModel(worker, resolvedModel),
        prompt,
        repoCwd: ctx.cwd,
        sessionDir,
        thinkingLevel: effort,
        sessionFactory: resolvedModel ? sessionFactoryForModel(resolvedModel) : undefined,
        onEvent: (e) => {
          if (e.type === "turn") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { turns: e.turns });
          if (e.type === "tokens") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { tokens: e.tokens });
          if (e.type === "cost") {
            fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { cost_usd_estimate: e.cost });
            checkCostWarning();
          }
          if (e.type === "error") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: e.message });
          updateWidget(ctx, fleet);
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, turns: 0, tokens: 0, error };
    }
  };

  try {
    const state = await runFleet({
      spec: fleet.spec,
      fleetRoot: fleet.fleetRoot,
      repoCwd: (nodeId) => {
        const worker = fleet.spec.workers.find((w) => w.id === nodeId);
        return worker?.worktree ? join(fleet.fleetRoot, "worktrees", nodeId) : ctx.cwd;
      },
      spawn,
      killSwitch: fleet.killSwitch,
      pauseSwitch: fleet.pauseSwitch,
      onNodeChange: (nodeId, nodeState) => {
        fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, nodeState);
        checkCostWarning();
        updateWidget(ctx, fleet);
      },
      prepareIteration: async (_n, state) => {
        fleet.state = state;
        await writeWorkerPrompts(fleet);
      },
      resumeFrom,
      continuePass,
    });
    fleet.state = state;
    fleet.running = false;
    stopSpinner();
    updateWidget(ctx, fleet); // keep final per-node stats visible (todo #12)
    const report = await writeReport({ spec: fleet.spec, state, fleetRoot: fleet.fleetRoot, repoCwd: ctx.cwd });
    const last = state.iterations[state.iterations.length - 1];
    if (state.status === "paused" && last?.verdict === "escalate") {
      if (ctx.hasUI) ctx.ui.notify(`fleet paused: reviewer escalated; report: ${join(fleet.fleetRoot, "report.md")}`, "warning");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`fleet ${state.status}; report: ${join(fleet.fleetRoot, "report.md")}`, state.status === "completed" ? "info" : "warning");
    }
  } catch (err: unknown) {
    fleet.running = false;
    stopSpinner();
    updateWidget(ctx, fleet);
    const error = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`fleet failed: ${error}`, "error");
  }
}

export async function killFleet(target: string): Promise<string> {
  const active = activeFleet.current;
  if (!active) return "no fleet planned yet";
  if (target !== "all") return "single-node kill not supported in v1 — use target \"all\"";
  active.killSwitch.killed = true;
  return "fleet kill requested";
}
