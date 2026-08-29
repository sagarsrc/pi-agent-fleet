import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateFleetSpec } from "./dag.js";
import { insertWorkers } from "./insert.js";
import { loadPreferences, mergeFleetConfig } from "./preferences.js";
import { activeFleet, currentState, dagPreview, ensureCanvas, killFleet, requestRelaunch, startLoop, statusText, stopCanvas, updateWidget } from "./controller.js";
import { openInBrowser, listFleetRoots } from "./canvas.js";
import { editConfig, editNode, type ConfigEditKey, type NodeEditKey } from "./edits.js";
import { ensureFleetGitignore, fleetRootFor, isInsideGitRepo, writePlanFiles, writeWorkerPrompts } from "./fleet-store.js";
import { recoverLatestFleet } from "./fleet-recovery.js";
import { listModelRefs, validateFleetModels } from "./model-resolution.js";
import { runFleetDesign, slugifyFleetName } from "./planner.js";
import { writeReport } from "./report.js";
import { initFleetState, writeState } from "./state.js";
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
    schema: Type.Optional(Type.Object({
      required_keys: Type.Optional(Type.Array(Type.String(), { description: "JSON object keys that must be present" })),
      number_keys: Type.Optional(Type.Array(Type.String(), { description: "JSON object keys that must be numbers or arrays of numbers" })),
    }, { description: "Optional JSON object shape; only valid with kind json" })),
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
      max_cost_usd: Type.Optional(Type.Number()),
      worker_extensions: Type.Optional(Type.Array(Type.String())),
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
      "Validate a fleet DAG definition, create its fleet root, and return an ASCII preview. Does NOT launch. PREREQUISITE: if the user's request is prose requirements or a goal rather than an explicit fleet definition, you MUST call fleet_design first and pass its drafted definition here — do not hand-write the fleet JSON yourself. Present the preview to the user; call fleet_launch only after they explicitly confirm. Choose models by task difficulty: cheap/fast models for trivial writers and validators, mid-tier coding models for code-run workers, strongest reasoning models for reviewers and synthesizers. When several models fit a tier, vary providers across nodes instead of defaulting to one family. Set worker.model per node to override config.model. All model refs are validated against the live registry — planning fails if any model is unavailable. Call fleet_models first if you do not know exact provider/model IDs.",
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
      const active = activeFleet.current = { spec: v.spec, fleetRoot, state, killSwitch: { killed: false }, pauseSwitch: { paused: false }, running: false, costWarned: false, sessions: new Map(), killedNodes: new Set(), relaunchRequests: new Set(), widgetVisible: false };
      updateWidget(ctx, active);

      const dag = await dagPreview(v.spec, undefined, fleetRoot);
      const canvas = ctx.hasUI ? await ensureCanvas(ctx) : undefined;
      return textResult(`${dag}\n\nfleet root: ${fleetRoot}${canvas ? `\nfleet canvas: ${canvas.url}` : ""}\n\nShow this preview to the user. Call fleet_launch only after they explicitly confirm.`, { fleetRoot, layers: v.layers, canvasUrl: canvas?.url });
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

      if (fleet.state.status !== "planned" || Object.values(fleet.state.nodes).some((n) => n.status !== "pending")) {
        return textResult(
          `fleet already started (${fleet.state.status}); use fleet_continue to resume pending work, fleet_relaunch <node_id> to retry a failed node, or start a new fleet with fleet_plan`,
        );
      }

      if (ctx.hasUI && !params.skip_confirm) {
        const ok = await ctx.ui.confirm("Launch fleet?", renderDag(fleet.spec));
        if (!ok) return textResult("fleet launch aborted");
      }

      await writeWorkerPrompts(fleet);
      const canvas = ctx.hasUI ? await ensureCanvas(ctx) : undefined;
      void startLoop(fleet, ctx, false);
      return textResult(`fleet launched${canvas ? `\n\nfleet canvas: ${canvas.url}` : ""}`, { canvasUrl: canvas?.url });
    },
  });

  pi.registerTool({
    name: "fleet_models",
    label: "Fleet Models",
    description: "List available model refs (provider/id) from the live registry. Call this before fleet_plan if you do not know exact provider/model IDs.",
    promptSnippet: "List available fleet model refs.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return textResult(`available models:\n${listModelRefs(ctx.modelRegistry).join("\n")}`);
    },
  });

  pi.registerTool({
    name: "fleet_status",
    label: "Fleet Status",
    description: "Show the current active fleet DAG and live widget lines.",
    promptSnippet: "Show current active fleet status.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current ?? await recoverLatestFleet(ctx.cwd);
      if (active) activeFleet.current ??= active;
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return textResult(await killFleet(params.target, ctx.cwd));
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
    name: "fleet_continue",
    label: "Fleet Continue",
    description: "Continue the active fleet from its current state without restarting completed nodes. Dispatches pending and ready nodes and unblocks downstream as dependencies complete. Use this after a failed/killed fleet to resume work safely.",
    promptSnippet: "Continue the active fleet from current state.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current ?? await recoverLatestFleet(ctx.cwd);
      if (active) activeFleet.current ??= active;
      if (!active) return textResult("no fleet planned yet");
      if (active.running) return textResult("fleet already running");
      await currentState(active);
      if (active.state.status === "completed") return textResult("fleet completed, nothing to continue");
      if (active.state.status === "paused") return textResult("fleet is paused; use fleet_resume for paused loop fleets");
      if (active.state.status === "planned" && Object.values(active.state.nodes).every((n) => n.status === "pending")) {
        return textResult("fleet has not started; use fleet_launch");
      }
      active.killSwitch.killed = false;
      active.pauseSwitch.paused = false;
      active.state = { ...active.state, status: "running", paused: false };
      await writeState(active.fleetRoot, active.state);
      await writeWorkerPrompts(active);
      void startLoop(active, ctx, false, true);
      return textResult("fleet continue requested");
    },
  });

  pi.registerTool({
    name: "fleet_relaunch",
    label: "Fleet Relaunch",
    description: "Relaunch a failed node and any blocked downstream dependents. Works while the fleet is running (queued for the next scheduler pass) and after it stops. Optionally override the worker model for this run.",
    promptSnippet: "Relaunch a failed fleet node.",
    parameters: Type.Object({
      node_id: Type.String({ description: "Worker id to relaunch" }),
      model: Type.Optional(Type.String({ description: "Optional model override for this run, e.g. provider/model-id" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      const fleet = active;
      await currentState(fleet);
      if (fleet.state.status === "completed") return textResult("fleet completed, nothing to relaunch");
      const result = await requestRelaunch(fleet, params.node_id, params.model, ctx.modelRegistry);
      if (result.startNow) void startLoop(fleet, ctx, false, true);
      return textResult(result.message);
    },
  });

  pi.registerTool({
    name: "fleet_add_node",
    label: "Fleet Add Node",
    description: "Insert one or more worker nodes into the active fleet's DAG on the fly. The merged graph is validated (unique ids, known deps, acyclic, loop-gate rules); inserted nodes start as pending and dispatch as soon as their deps complete — including mid-run. Refused on completed fleets.",
    promptSnippet: "Add worker nodes to the active fleet DAG.",
    parameters: Type.Object({
      workers: Type.Array(WorkerSchema, { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      await currentState(active);
      const r = await insertWorkers(active, params.workers, ctx.modelRegistry);
      if (r.ok) updateWidget(ctx, active);
      return textResult(r.message, { inserted: r.inserted ?? [] });
    },
  });

  pi.registerTool({
    name: "fleet_design",
    label: "Fleet Design",
    description: "Draft a fleet DAG from plain-language requirements — this is the REQUIRED first step whenever the user describes a goal in prose instead of giving an explicit fleet definition. Spawns a planner agent that writes a fleet.json definition, validates it, and returns an ASCII preview with the JSON. Does NOT plan or launch anything. After the user approves the preview, pass the drafted definition to fleet_plan.",
    promptSnippet: "Draft a fleet DAG from plain-language requirements.",
    parameters: Type.Object({
      requirements: Type.String({ description: "Plain-language description of the goal" }),
      fleet_name: Type.Optional(Type.String({ description: "kebab-case; derived from requirements when omitted" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const fleetName = params.fleet_name ?? slugifyFleetName(params.requirements);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(fleetName)) {
        return textResult(`fleet_name "${fleetName}" must be kebab-case`);
      }
      const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const designRoot = join(ctx.cwd, ".fleet", `design-${fleetName}-${ts}`);
      await ensureFleetGitignore(ctx.cwd);
      const result = await runFleetDesign({
        requirements: params.requirements,
        fleetName,
        designRoot,
        repoCwd: ctx.cwd,
      });
      if (!result.ok) return textResult(`fleet design failed: ${result.error}`);
      const v = validateFleetSpec(result.draft);
      if (!v.ok) {
        return textResult(
          `planner produced an invalid fleet:\n${v.errors.join("\n")}\n\ndraft JSON:\n${JSON.stringify(result.draft, null, 2)}\n\nFix the JSON and call fleet_plan directly, or retry fleet_design with clearer requirements.`,
        );
      }
      const dag = renderDag(v.spec);
      return textResult(
        `${dag}\n\nrationale: ${join(designRoot, "planner", "output", "rationale.md")}\n\nfleet JSON:\n${JSON.stringify(result.draft, null, 2)}\n\nShow this preview to the user. If they approve, call fleet_plan with this definition (fleet_launch only after their explicit confirmation).`,
        { designRoot },
      );
    },
  });

  pi.registerTool({
    name: "fleet_report",
    label: "Fleet Report",
    description: "Regenerate and return the active fleet markdown report from current state.",
    promptSnippet: "Regenerate the active fleet report.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current ?? await recoverLatestFleet(ctx.cwd);
      if (active) activeFleet.current ??= active;
      if (!active) return textResult("no fleet planned yet");
      const state = await currentState(active);
      const report = await writeReport({ spec: active.spec, state, fleetRoot: active.fleetRoot, repoCwd: ctx.cwd });
      return textResult(report, { reportPath: join(active.fleetRoot, "report.md") });
    },
  });

  pi.registerTool({
    name: "fleet_edit",
    label: "Fleet Edit",
    description: "Edit the active fleet: a pending or relaunchable node's model, effort, or task — or fleet config (max_concurrent, warn_cost_usd, max_cost_usd, model, effort) when node_id is omitted. Changes persist to fleet.json and apply immediately. Edits to running or completed nodes are refused; pending, blocked, failed, contract_failed, and killed nodes can be edited (blocked nodes have not started — nothing to invalidate).",
    promptSnippet: "Edit a pending fleet node or fleet config.",
    parameters: Type.Object({
      node_id: Type.Optional(Type.String({ description: "Worker id to edit; omit for fleet config edits" })),
      key: Type.String({ description: "Node keys: model, effort, task. Config keys: max_concurrent, warn_cost_usd, max_cost_usd, model, effort" }),
      value: Type.String({ description: "New value" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = activeFleet.current;
      if (!active) return textResult("no fleet planned yet");
      await currentState(active);
      const r = params.node_id
        ? await editNode(active, params.node_id, params.key as NodeEditKey, params.value, ctx.modelRegistry)
        : await editConfig(active, params.key as ConfigEditKey, params.value, ctx.modelRegistry);
      if (r.ok) updateWidget(ctx, active);
      return textResult(r.message);
    },
  });

  pi.registerTool({
    name: "fleet_canvas",
    label: "Fleet Canvas",
    description: "Open a local browser canvas for the active fleet: live DAG with per-node stats and a click-to-peek view of each node's recent agent session. Read-only, binds 127.0.0.1 on an ephemeral port. action 'url' (default) returns the URL without opening a browser; 'open' opens it; 'stop' shuts the server down.",
    promptSnippet: "Open the fleet browser canvas.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("stop"), Type.Literal("url")])),
      fleet: Type.Optional(Type.String({ description: "Fleet root dir basename under .fleet to visualize (e.g. energy-brief-20260803000000); omit for the live fleet" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "url";
      if (action === "stop") {
        await stopCanvas();
        return textResult("fleet canvas stopped");
      }
      const server = await ensureCanvas(ctx);
      let url = server.url;
      if (params.fleet) {
        const roots = await listFleetRoots(ctx.cwd);
        if (!roots.some((r) => r.name === params.fleet)) return textResult(`unknown fleet "${params.fleet}"`);
        url = `${url}?fleet=${encodeURIComponent(params.fleet)}`;
      }
      if (action === "open") await openInBrowser(url);
      return textResult(`fleet canvas: ${url}`, { url: url });
    },
  });
}
