import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { validateFleetSpec } from "./dag.js";
import { buildWorkerPrompt } from "./prompts.js";
import { writeReport } from "./report.js";
import { runWorker, type AgentSessionLike, type SessionFactory } from "./runner.js";
import { runFleet } from "./scheduler.js";
import { initFleetState, patchNode, readState, writeState } from "./state.js";
import type { FleetSpec, FleetState, WorkerSpec } from "./types.js";
import { buildWidgetLines } from "./ui.js";
import { dagNeedsFileFallback, renderDag } from "./viz.js";

export interface ActiveFleet {
  spec: FleetSpec;
  fleetRoot: string;
  state: FleetState;
  killSwitch: { killed: boolean };
  running: boolean;
}

let active: ActiveFleet | undefined;

function fleetRootFor(cwd: string, name: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return join(cwd, ".fleet", `${name}-${ts}`);
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

async function ensureFleetGitignore(cwd: string): Promise<void> {
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

async function writePlanFiles(fleetRoot: string, spec: FleetSpec, state: FleetState): Promise<void> {
  await mkdir(fleetRoot, { recursive: true });
  await Promise.all(spec.workers.map((w) => mkdir(join(fleetRoot, "workers", w.id, "output"), { recursive: true })));
  await writeFile(join(fleetRoot, "fleet.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
  await writeState(fleetRoot, state);
}

async function writeWorkerPrompts(fleet: ActiveFleet): Promise<void> {
  await Promise.all(fleet.spec.workers.map(async (w) => {
    const prompt = buildWorkerPrompt({ spec: fleet.spec, state: fleet.state, workerId: w.id, fleetRoot: fleet.fleetRoot });
    await writeFile(join(fleet.fleetRoot, "workers", w.id, "prompt.md"), prompt, "utf-8");
  }));
}

function aliasesFor(model: Model<Api>): string[] {
  const extra = model as Model<Api> & { alias?: unknown; aliases?: unknown };
  return [
    model.id,
    model.name,
    ...(typeof extra.alias === "string" ? [extra.alias] : []),
    ...(Array.isArray(extra.aliases) ? extra.aliases.filter((a): a is string => typeof a === "string") : []),
  ];
}

function resolveModelReference(
  registry: ExtensionContext["modelRegistry"],
  ref: string,
): { ok: true; model: Model<Api> } | { ok: false; error: string } {
  const models = registry.getAvailable();
  const pool = models.length > 0 ? models : registry.getAll();
  const needle = ref.toLowerCase();
  const canonical = (m: Model<Api>) => `${m.provider}/${m.id}`.toLowerCase();
  const byAlias = (m: Model<Api>, pred: (v: string) => boolean) => aliasesFor(m).some((a) => pred(a.toLowerCase()));

  const tiers: Model<Api>[][] = [];
  if (needle.includes("/")) {
    tiers.push(pool.filter((m) => canonical(m) === needle));
    const [provider, ...rest] = needle.split("/");
    const alias = rest.join("/");
    tiers.push(pool.filter((m) => m.provider.toLowerCase() === provider && byAlias(m, (a) => a === alias)));
  }
  tiers.push(pool.filter((m) => m.id.toLowerCase() === needle));
  tiers.push(pool.filter((m) => byAlias(m, (a) => a === needle)));
  tiers.push(pool.filter((m) => byAlias(m, (a) => a.startsWith(needle))));
  tiers.push(pool.filter((m) => byAlias(m, (a) => a.includes(needle))));

  for (const tier of tiers) {
    const unique = [...new Map(tier.map((m) => [`${m.provider}/${m.id}`, m])).values()];
    if (unique.length === 1) return { ok: true, model: unique[0] };
    if (unique.length > 1) {
      return {
        ok: false,
        error: `model "${ref}" is ambiguous: ${unique.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
      };
    }
  }
  return { ok: false, error: `model "${ref}" not found` };
}

function sessionFactoryForModel(model: Model<Api>): SessionFactory {
  return async (opts) => {
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      tools: opts.tools,
      sessionManager: SessionManager.create(opts.cwd, opts.sessionDir),
      model,
    });
    return session as unknown as AgentSessionLike;
  };
}

function workerWithResolvedModel(worker: WorkerSpec, model: Model<Api> | undefined): WorkerSpec {
  return model ? { ...worker, model: `${model.provider}/${model.id}` } : worker;
}

function updateWidget(ctx: ExtensionContext, fleet: ActiveFleet): void {
  if (ctx.hasUI) ctx.ui.setWidget("fleet", buildWidgetLines(fleet.spec, fleet.state));
}

async function currentState(fleet: ActiveFleet): Promise<FleetState> {
  if (fleet.running) return fleet.state;
  try {
    fleet.state = await readState(fleet.fleetRoot);
  } catch {
    // keep in-memory state
  }
  return fleet.state;
}

async function statusText(fleet: ActiveFleet): Promise<string> {
  const state = await currentState(fleet);
  return renderDag(fleet.spec, state);
}

async function dagPreview(spec: FleetSpec, state: FleetState | undefined, fleetRoot: string): Promise<string> {
  const out = renderDag(spec, state);
  const width = process.stdout.columns ?? 120;
  if (dagNeedsFileFallback(spec, width)) {
    const p = join(fleetRoot, "dag.txt");
    await writeFile(p, out, "utf-8");
    return `${out}\n\nDAG preview saved: ${p}`;
  }
  return out;
}

async function killFleet(target: string): Promise<string> {
  if (!active) return "no fleet planned yet";
  if (target !== "all") return "single-node kill not supported in v1 — use target \"all\"";
  active.killSwitch.killed = true;
  return "fleet kill requested";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    active = undefined;
    ctx.ui.setStatus("fleet", "");
  });

  const OutputSchema = Type.Object({
    path: Type.String({ description: 'output/... paths resolve under the worker dir; anything else is repo-relative (code edits)' }),
    kind: Type.Union([
      Type.Literal("markdown"), Type.Literal("file-exists"),
      Type.Literal("verdict"), Type.Literal("json"), Type.Literal("yaml"),
    ]),
    required: Type.Optional(Type.Boolean()),
  });
  const WorkerSchema = Type.Object({
    id: Type.String({ description: "kebab-case, e.g. counter-a" }),
    type: Type.Union([
      Type.Literal("research"), Type.Literal("code-run"),
      Type.Literal("reviewer"), Type.Literal("write"), Type.Literal("read-only"),
    ]),
    task: Type.String({ description: "Full task instructions for the worker" }),
    model: Type.Optional(Type.String({ description: "Per-worker model override, e.g. gpt-5.4-mini" })),
    depends_on: Type.Optional(Type.Array(Type.String())),
    outputs: Type.Optional(Type.Array(OutputSchema)),
  });
  const FleetSchema = Type.Object({
    fleet_name: Type.String({ description: "kebab-case" }),
    type: Type.Literal("dag"),
    config: Type.Optional(Type.Object({
      max_concurrent: Type.Optional(Type.Number()),
      model: Type.Optional(Type.String({ description: "Fleet-wide default model" })),
      warn_cost_usd: Type.Optional(Type.Number()),
    })),
    workers: Type.Array(WorkerSchema, { minItems: 1 }),
  });

  pi.registerTool({
    name: "fleet_plan",
    label: "Fleet Plan",
    description:
      "Validate a fleet DAG definition, create its fleet root, and return an ASCII preview. Does NOT launch. Call fleet_launch after the user confirms the preview. Model selection standard: cheap/fast models (e.g. gpt-5.4-mini, kimi-for-coding-highspeed) for trivial writers/validators; coding models (e.g. kimi-for-coding, gpt-5.5) for code-run workers; strong reasoning models (e.g. k3, gpt-5.6-sol) for reviewers/synthesizers. Set worker.model per node to override config.model.",
    promptSnippet: "Plan a DAG-of-agents fleet from a fleet definition without launching it.",
    parameters: Type.Object({
      fleet: FleetSchema,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const v = validateFleetSpec(params.fleet);
      if (!v.ok) return textResult(`Invalid fleet:\n${v.errors.join("\n")}`);

      const fleetRoot = fleetRootFor(ctx.cwd, v.spec.fleet_name);
      const state = initFleetState(v.spec);
      await ensureFleetGitignore(ctx.cwd);
      await writePlanFiles(fleetRoot, v.spec, state);
      active = { spec: v.spec, fleetRoot, state, killSwitch: { killed: false }, running: false };
      updateWidget(ctx, active);

      const dag = await dagPreview(v.spec, undefined, fleetRoot);
      return textResult(`${dag}\n\nfleet root: ${fleetRoot}\ncall fleet_launch to start`, { fleetRoot, layers: v.layers });
    },
  });

  pi.registerTool({
    name: "fleet_launch",
    label: "Fleet Launch",
    description: "Launch the active planned fleet. Runs the DAG in the background and updates the live fleet widget. Pass skip_confirm: true to bypass the interactive confirmation (e.g. when the user already approved the plan or is running unattended).",
    promptSnippet: "Launch the currently planned fleet after preview confirmation.",
    parameters: Type.Object({
      skip_confirm: Type.Optional(Type.Boolean({ description: "Skip the interactive launch confirmation dialog" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!active) return textResult("no fleet planned yet");
      if (active.running) return textResult("fleet already running");
      const fleet = active;

      if (ctx.hasUI && !params.skip_confirm) {
        const ok = await ctx.ui.confirm("Launch fleet?", renderDag(fleet.spec));
        if (!ok) return textResult("fleet launch aborted");
      }

      await writeWorkerPrompts(fleet);
      fleet.running = true;
      updateWidget(ctx, fleet);

      const spawn = async (nodeId: string) => {
        try {
          const worker = fleet.spec.workers.find((w) => w.id === nodeId);
          if (!worker) return { ok: false, turns: 0, tokens: 0, error: `unknown worker "${nodeId}"` };

          let resolvedModel: Model<Api> | undefined;
          let modelNote: string | undefined;
          if (worker.model) {
            // explicit per-worker model: hard error if unresolvable
            const resolved = resolveModelReference(ctx.modelRegistry, worker.model);
            if (!resolved.ok) return { ok: false, turns: 0, tokens: 0, error: resolved.error };
            resolvedModel = resolved.model;
          } else if (fleet.spec.config.model) {
            // fleet default: warn + session default if unresolvable (fleet may be planned on another machine)
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
          return await runWorker({
            nodeId,
            worker: workerWithResolvedModel(worker, resolvedModel),
            prompt,
            repoCwd: ctx.cwd,
            sessionDir,
            sessionFactory: resolvedModel ? sessionFactoryForModel(resolvedModel) : undefined,
            onEvent: (e) => {
              if (e.type === "turn") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { turns: e.turns });
              if (e.type === "tokens") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { tokens: e.tokens });
              if (e.type === "error") fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, { status_note: e.message });
              updateWidget(ctx, fleet);
            },
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { ok: false, turns: 0, tokens: 0, error };
        }
      };

      void runFleet({
        spec: fleet.spec,
        fleetRoot: fleet.fleetRoot,
        repoCwd: ctx.cwd,
        spawn,
        killSwitch: fleet.killSwitch,
        onNodeChange: (nodeId, nodeState) => {
          fleet.state = patchNode(fleet.fleetRoot, fleet.state, nodeId, nodeState);
          updateWidget(ctx, fleet);
        },
      }).then(async (state) => {
        fleet.state = state;
        fleet.running = false;
        if (ctx.hasUI) ctx.ui.setWidget("fleet", []);
        const report = await writeReport({ spec: fleet.spec, state, fleetRoot: fleet.fleetRoot, repoCwd: ctx.cwd });
        if (ctx.hasUI) ctx.ui.notify(`fleet ${state.status}; report: ${join(fleet.fleetRoot, "report.md")}`, state.status === "completed" ? "info" : "warning");
        return report;
      }).catch((err: unknown) => {
        fleet.running = false;
        if (ctx.hasUI) ctx.ui.setWidget("fleet", []);
        const error = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`fleet failed: ${error}`, "error");
      });

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
      if (!active) return textResult("no fleet planned yet");
      return textResult(await statusText(active));
    },
  });

  pi.registerTool({
    name: "fleet_kill",
    label: "Fleet Kill",
    description: "Request fleet-wide kill. Use target \"all\". Single-node kill is not supported in v1.",
    promptSnippet: "Kill the active fleet with target \"all\".",
    parameters: Type.Object({ target: Type.String({ description: "Use all. Node ids are not supported in v1." }) }),
    async execute(_id, params) {
      return textResult(await killFleet(params.target));
    },
  });

  pi.registerTool({
    name: "fleet_report",
    label: "Fleet Report",
    description: "Regenerate and return the active fleet markdown report from current state.",
    promptSnippet: "Regenerate the active fleet report.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!active) return textResult("no fleet planned yet");
      const state = await currentState(active);
      const report = await writeReport({ spec: active.spec, state, fleetRoot: active.fleetRoot, repoCwd: ctx.cwd });
      return textResult(report, { reportPath: join(active.fleetRoot, "report.md") });
    },
  });

  pi.registerCommand("fleet", {
    description: "Fleet commands: /fleet viz, /fleet status, /fleet clear, /fleet kill all",
    handler: async (args, ctx) => {
      const [cmd, target] = args.trim().split(/\s+/);
      if (!active) {
        ctx.ui.notify("no fleet planned yet", "warning");
        return;
      }
      if (cmd === "viz") {
        const lines = renderDag(active.spec, active.state).split("\n");
        ctx.ui.setWidget("fleet", lines);
        return;
      }
      if (cmd === "status" || cmd === "") {
        ctx.ui.setWidget("fleet", buildWidgetLines(active.spec, active.state));
        return;
      }
      if (cmd === "clear") {
        ctx.ui.setWidget("fleet", []);
        return;
      }
      if (cmd === "kill") {
        const text = await killFleet(target ?? "");
        ctx.ui.notify(text, text === "fleet kill requested" ? "warning" : "error");
        return;
      }
      ctx.ui.notify("usage: /fleet viz | /fleet status | /fleet clear | /fleet kill all", "warning");
    },
  });
}
