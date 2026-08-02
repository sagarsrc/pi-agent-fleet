import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateFleetSpec } from "./dag.js";
import { loadPreferences, mergeFleetConfig } from "./preferences.js";
import { activeFleet, currentState, dagPreview, killFleet, prepareRelaunch, startLoop, statusText, updateWidget } from "./controller.js";
import { ensureFleetGitignore, fleetRootFor, isInsideGitRepo, writePlanFiles, writeWorkerPrompts } from "./fleet-store.js";
import { resolveModelReference, validateFleetModels } from "./model-resolution.js";
import { writeReport } from "./report.js";
import { initFleetState, resetForRelaunch, writeState } from "./state.js";
import { renderDag } from "./viz.js";

export function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function registerFleetTools(pi: ExtensionAPI): void {
  const OutputSchema = Type.Object({
    path: Type.String({ description: 'output/... paths resolve under the worker dir; anything else is repo-relative (code edits)' }),
    kind: Type.Union([
      Type.Literal("markdown"), Type.Literal("file-exists"),
      Type.Literal("verdict"), Type.Literal("json"), Type.Literal("yaml"),
    ]),
    required: Type.Optional(Type.Boolean()),
  });
  const EffortSchema = Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
    Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ], { description: "Thinking effort level" });
  const WorkerSchema = Type.Object({
    id: Type.String({ description: "kebab-case, e.g. counter-a" }),
    type: Type.Union([
      Type.Literal("research"), Type.Literal("code-run"),
      Type.Literal("reviewer"), Type.Literal("write"), Type.Literal("read-only"),
    ]),
    task: Type.String({ description: "Full task instructions for the worker" }),
    model: Type.Optional(Type.String({ description: "Per-worker model override, e.g. provider/model-id" })),
    effort: Type.Optional(EffortSchema),
    depends_on: Type.Optional(Type.Array(Type.String())),
    outputs: Type.Optional(Type.Array(OutputSchema)),
    iterate: Type.Optional(Type.Boolean({ description: "Replay node on each loop iteration" })),
    worktree: Type.Optional(Type.Boolean({ description: "Run in a dedicated git worktree" })),
  });
  const FleetSchema = Type.Object({
    fleet_name: Type.String({ description: "kebab-case" }),
    type: Type.Literal("dag"),
    config: Type.Optional(Type.Object({
      max_concurrent: Type.Optional(Type.Number()),
      model: Type.Optional(Type.String({ description: "Fleet-wide default model" })),
      effort: Type.Optional(EffortSchema),
      warn_cost_usd: Type.Optional(Type.Number()),
      loop: Type.Optional(Type.Object({
        gate: Type.Union([Type.Literal("reviewer"), Type.Literal("none")]),
        max_iterations: Type.Number(),
        lgtm_count: Type.Optional(Type.Number()),
      })),
    })),
    workers: Type.Array(WorkerSchema, { minItems: 1 }),
  });

  pi.registerTool({
    name: "fleet_plan",
    label: "Fleet Plan",
    description:
      "Validate a fleet DAG definition, create its fleet root, and return an ASCII preview. Does NOT launch. Present the preview to the user; call fleet_launch only after they explicitly confirm. Choose models by task difficulty: cheap/fast models for trivial writers and validators, mid-tier coding models for code-run workers, strongest reasoning models for reviewers and synthesizers. When several models fit a tier, vary providers across nodes instead of defaulting to one family. Set worker.model per node to override config.model. All model refs are validated against the live registry — planning fails if any model is unavailable.",
    promptSnippet: "Plan a DAG-of-agents fleet from a fleet definition without launching it.",
    parameters: Type.Object({
      fleet: FleetSchema,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const prefs = await loadPreferences();
      const v = validateFleetSpec(mergeFleetConfig(params.fleet, prefs));
      if (!v.ok) return textResult(`Invalid fleet:\n${v.errors.join("\n")}`);

      const modelCheck = validateFleetModels(v.spec, ctx.modelRegistry);
      if (!modelCheck.ok) return textResult(`Invalid fleet:\n${modelCheck.errors.join("\n")}`);

      const fleetRoot = fleetRootFor(ctx.cwd, v.spec.fleet_name);
      const state = initFleetState(v.spec);
      await ensureFleetGitignore(ctx.cwd);
      await writePlanFiles(fleetRoot, v.spec, state);
      const active = activeFleet.current = { spec: v.spec, fleetRoot, state, killSwitch: { killed: false }, pauseSwitch: { paused: false }, running: false, costWarned: false, sessions: new Map(), killedNodes: new Set() };
      updateWidget(ctx, active);

      const dag = await dagPreview(v.spec, undefined, fleetRoot);
      return textResult(`${dag}\n\nfleet root: ${fleetRoot}\nShow this preview to the user. Call fleet_launch only after they explicitly confirm.`, { fleetRoot, layers: v.layers });
    },
  });

  pi.registerTool({
    name: "fleet_launch",
    label: "Fleet Launch",
    description: "Launch the active planned fleet after the user has confirmed the plan preview. Runs the DAG in the background and updates the live fleet widget. Pass skip_confirm: true only when the user already approved this exact plan (e.g. unattended runs); otherwise the interactive confirmation is shown.",
    promptSnippet: "Launch the currently planned fleet after preview confirmation.",
    parameters: Type.Object({
      skip_confirm: Type.Optional(Type.Boolean({ description: "Skip the interactive launch confirmation dialog" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      if (active.running) return textResult("fleet already running");
      const fleet = active;

      const modelCheck = validateFleetModels(fleet.spec, ctx.modelRegistry);
      if (!modelCheck.ok) {
        return textResult(`Cannot launch — unresolvable models:\n${modelCheck.errors.join("\n")}`);
      }

      if (fleet.spec.workers.some((w) => w.worktree === true)) {
        if (!(await isInsideGitRepo(ctx.cwd))) {
          return textResult(`worktree workers require a git repo; none found above ${ctx.cwd}`);
        }
      }

      if (ctx.hasUI && !params.skip_confirm) {
        const ok = await ctx.ui.confirm("Launch fleet?", renderDag(fleet.spec));
        if (!ok) return textResult("fleet launch aborted");
      }

      await writeWorkerPrompts(fleet);
      void startLoop(fleet, ctx, false);
      return textResult("fleet launched");
    },
  });

  pi.registerTool({
    name: "fleet_status",
    label: "Fleet Status",
    description: "Show the current active fleet DAG and live widget lines.",
    promptSnippet: "Show current active fleet status.",
    parameters: Type.Object({}),
    async execute() {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      return textResult(await statusText(active));
    },
  });

  pi.registerTool({
    name: "fleet_kill",
    label: "Fleet Kill",
    description: "Request a fleet-wide kill (target \"all\") or kill a single node by worker id. Killing a running node aborts its session; killing a pending node marks it killed at the next dispatch pass. Killed nodes can be revived with fleet_relaunch.",
    promptSnippet: "Kill the whole fleet or a single node by worker id.",
    parameters: Type.Object({ target: Type.String({ description: "all or a worker id" }) }),
    async execute(_id, params) {
      return textResult(await killFleet(params.target));
    },
  });

  pi.registerTool({
    name: "fleet_pause",
    label: "Fleet Pause",
    description: "Request a pause of the active running loop fleet. The pause takes effect at the next iteration boundary.",
    promptSnippet: "Pause the active fleet at the next iteration boundary.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      if (!active.spec.config.loop) return textResult("fleet has no loop; pause is a loop-fleet operation");
      if (!active.running) return textResult("fleet not running");
      active.pauseSwitch.paused = true;
      active.state = { ...active.state, paused: true };
      await writeState(active.fleetRoot, active.state);
      updateWidget(ctx, active);
      return textResult("pause requested (takes effect at next iteration boundary)");
    },
  });

  pi.registerTool({
    name: "fleet_resume",
    label: "Fleet Resume",
    description: "Resume a paused loop fleet from the current iteration.",
    promptSnippet: "Resume the paused active fleet.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      if (active.state.status !== "paused") return textResult("fleet is not paused");
      if (active.running) return textResult("fleet already running");
      active.pauseSwitch.paused = false;
      void startLoop(active, ctx, true);
      return textResult("fleet resumed");
    },
  });

  pi.registerTool({
    name: "fleet_relaunch",
    label: "Fleet Relaunch",
    description: "Relaunch a failed node and any blocked downstream dependents. Optionally override the worker model for this run.",
    promptSnippet: "Relaunch a failed fleet node.",
    parameters: Type.Object({
      node_id: Type.String({ description: "Worker id to relaunch" }),
      model: Type.Optional(Type.String({ description: "Optional model override for this run, e.g. provider/model-id" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      if (active.running) return textResult("fleet is running");
      const fleet = active;
      await currentState(fleet);
      if (fleet.state.status === "completed") return textResult("fleet completed, nothing to relaunch");
      const worker = fleet.spec.workers.find((w) => w.id === params.node_id);
      if (!worker) return textResult(`unknown node "${params.node_id}"`);
      const node = fleet.state.nodes[params.node_id];
      const relaunchable: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed"]);
      if (!node || !relaunchable.has(node.status)) {
        return textResult(`node "${params.node_id}" status ${node?.status ?? "missing"} cannot be relaunched; must be failed, contract_failed, or killed`);
      }
      if (params.model) {
        const resolved = resolveModelReference(ctx.modelRegistry, params.model);
        if (!resolved.ok) return textResult(resolved.error);
        const canonical = `${resolved.model.provider}/${resolved.model.id}`;
        fleet.spec.workers = fleet.spec.workers.map((w) => w.id === params.node_id ? { ...w, model: canonical } : w);
        await writeFile(join(fleet.fleetRoot, "fleet.json"), `${JSON.stringify(fleet.spec, null, 2)}\n`, "utf-8");
      }
      fleet.state = resetForRelaunch(fleet.state, fleet.spec, params.node_id);
      await writeState(fleet.fleetRoot, fleet.state);
      prepareRelaunch(fleet, params.node_id);
      void startLoop(fleet, ctx, false, true);
      return textResult(`fleet relaunch requested for ${params.node_id}`);
    },
  });

  pi.registerTool({
    name: "fleet_report",
    label: "Fleet Report",
    description: "Regenerate and return the active fleet markdown report from current state.",
    promptSnippet: "Regenerate the active fleet report.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      const state = await currentState(active);
      const report = await writeReport({ spec: active.spec, state, fleetRoot: active.fleetRoot, repoCwd: ctx.cwd });
      return textResult(report, { reportPath: join(active.fleetRoot, "report.md") });
    },
  });
}
