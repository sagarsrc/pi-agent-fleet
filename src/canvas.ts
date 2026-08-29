import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ActiveFleet } from "./controller.js";
import { listFleetRoots, readDiskFleet } from "./fleet-recovery.js";

export { listFleetRoots, readDiskFleet };
export type { FleetRootInfo } from "./fleet-recovery.js";

const execFileP = promisify(execFile);

export interface CanvasNodeView {
  id: string;
  type: string;
  task: string;
  status: string;
  model: string;
  effort?: string;
  turns: number;
  tokens: number;
  cost_usd_estimate: number;
  status_note?: string;
  produced_outputs: string[];
  outputs: Array<{ path: string; kind: string; required: boolean }>;
  depends_on: string[];
  iterate: boolean;
  worktree: boolean;
}

export interface CanvasPayload {
  fleet_name: string;
  status: string;
  created_at: string;
  iteration: number;
  lgtm_streak: number;
  paused: boolean;
  cost_usd_estimate: number;
  demo?: boolean;
  loop?: { gate: string; max_iterations: number; lgtm_count: number };
  config: { max_concurrent: number; model?: string; effort?: string; warn_cost_usd?: number };
  nodes: CanvasNodeView[];
  edges: Array<{ from: string; to: string }>;
  iterations: Array<{ n: number; verdict: string | null; cost: number; tokens: number; duration_ms: number }>;
  generated_at: string;
}

export function buildCanvasPayload(fleet: ActiveFleet): CanvasPayload {
  const { spec, state } = fleet;
  return {
    fleet_name: spec.fleet_name,
    status: state.status,
    created_at: state.created_at,
    iteration: state.iteration,
    lgtm_streak: state.lgtm_streak,
    paused: state.paused,
    cost_usd_estimate: state.cost_usd_estimate,
    loop: spec.config.loop
      ? { gate: spec.config.loop.gate, max_iterations: spec.config.loop.max_iterations, lgtm_count: spec.config.loop.lgtm_count }
      : undefined,
    config: {
      max_concurrent: spec.config.max_concurrent,
      model: spec.config.model,
      effort: spec.config.effort,
      warn_cost_usd: spec.config.warn_cost_usd,
    },
    nodes: spec.workers.map((w) => {
      const n = state.nodes[w.id];
      return {
        id: w.id,
        type: w.type,
        task: w.task,
        status: n?.status ?? "pending",
        model: w.model ?? spec.config.model ?? "(default)",
        effort: w.effort ?? spec.config.effort,
        turns: n?.turns ?? 0,
        tokens: n?.tokens ?? 0,
        cost_usd_estimate: n?.cost_usd_estimate ?? 0,
        status_note: n?.status_note,
        produced_outputs: n?.produced_outputs ?? [],
        outputs: w.outputs.map((o) => ({ path: o.path, kind: o.kind, required: o.required })),
        depends_on: [...w.depends_on],
        iterate: w.iterate !== false,
        worktree: w.worktree === true,
      };
    }),
    edges: spec.workers.flatMap((w) => w.depends_on.map((d) => ({ from: d, to: w.id }))),
    iterations: state.iterations.map((it) => ({
      n: it.n,
      verdict: it.verdict,
      cost: Object.values(it.nodes).reduce((s, n) => s + n.cost_usd_estimate, 0),
      tokens: Object.values(it.nodes).reduce((s, n) => s + n.tokens, 0),
      duration_ms: new Date(it.ended_at).getTime() - new Date(it.started_at).getTime(),
    })),
    generated_at: new Date().toISOString(),
  };
}

/** Baked snapshot of a real fleet (quickcall-zero-to-hero) used as the demo /
    fallback view when no fleet is live. Structure is hardcoded, not read from disk. */
const DEMO_FLEET = (
{
  "fleet_name": "quickcall-zero-to-hero",
  "status": "running",
  "created_at": "2026-08-02T12:49:37.320Z",
  "iteration": 1,
  "lgtm_streak": 0,
  "paused": false,
  "cost_usd_estimate": 13.8376735,
  "loop": {
    "gate": "reviewer",
    "max_iterations": 2,
    "lgtm_count": 1
  },
  "config": {
    "max_concurrent": 4,
    "model": "gpt-5.4",
    "warn_cost_usd": 50
  },
  "nodes": [
    {
      "id": "l1-methods",
      "type": "research",
      "task": "You are L1 (lay-of-the-land) researcher in a 2-layer research fleet. Mission context: founder built QuickCall — a daemon watching engineers' AI coding-agent sessions (Claude Code, Cursor, Codex), extracting team conventions, capturing ac…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 84,
      "tokens": 3446330,
      "cost_usd_estimate": 1.7322095000000008,
      "produced_outputs": [
        "output/l1-methods.md"
      ],
      "outputs": [
        {
          "path": "output/l1-methods.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l1-models-data",
      "type": "research",
      "task": "You are L1 (lay-of-the-land) researcher in a 2-layer fleet. Mission context: founder built QuickCall — daemon watching engineers' AI coding-agent sessions, capturing accept/reject signals and human corrections on agent output. Pitch in 2…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 30,
      "tokens": 3795144,
      "cost_usd_estimate": 2.4356045,
      "produced_outputs": [
        "output/l1-models-data.md"
      ],
      "outputs": [
        {
          "path": "output/l1-models-data.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l1-economics",
      "type": "research",
      "task": "You are L1 (lay-of-the-land) researcher in a 2-layer fleet. Context: founder pitching Head of AI at a foundation lab in 2 days — post-training open code models on preference traces from QuickCall (daemon capturing accept/reject/correctio…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 77,
      "tokens": 2852546,
      "cost_usd_estimate": 1.447467,
      "produced_outputs": [
        "output/l1-economics.md"
      ],
      "outputs": [
        {
          "path": "output/l1-economics.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l1-market",
      "type": "research",
      "task": "You are L1 (lay-of-the-land) researcher in a 2-layer fleet. Context: founder pitching Head of AI at a foundation lab in 2 days. Startup QuickCall: daemon on dev machines capturing AI coding-agent sessions → team conventions + accept/reje…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 28,
      "tokens": 1473836,
      "cost_usd_estimate": 1.2037,
      "produced_outputs": [
        "output/l1-market.md"
      ],
      "outputs": [
        {
          "path": "output/l1-market.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l2-deep-methods",
      "type": "research",
      "task": "You are L2 (double-down) researcher in a 2-layer fleet. Context: founder pitching Head of AI at a foundation lab in 2 days — post-training open code models on preference traces from QuickCall (daemon capturing accept/reject/corrections f…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 88,
      "tokens": 5299748,
      "cost_usd_estimate": 1.9066499999999997,
      "produced_outputs": [
        "output/l2-deep-methods.md"
      ],
      "outputs": [
        {
          "path": "output/l2-deep-methods.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [
        "l1-methods",
        "l1-models-data",
        "l1-economics",
        "l1-market"
      ],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l2-deep-data",
      "type": "research",
      "task": "You are L2 (double-down) researcher in a 2-layer fleet. Context: founder pitching Head of AI at a foundation lab in 2 days — post-training open code models on preference traces from QuickCall. QuickCall daemon captures: agent suggestions…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 50,
      "tokens": 5052879,
      "cost_usd_estimate": 2.2376524999999994,
      "produced_outputs": [
        "output/l2-deep-data.md"
      ],
      "outputs": [
        {
          "path": "output/l2-deep-data.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [
        "l1-methods",
        "l1-models-data",
        "l1-economics",
        "l1-market"
      ],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l2-deep-pilot",
      "type": "research",
      "task": "You are L2 (double-down) researcher in a 2-layer fleet. Context: founder pitching Head of AI at a foundation lab in 2 days — post-training open code models on preference traces from QuickCall. L1 surveys at workers/l1-*/output/l1-*.md — …",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 43,
      "tokens": 3580622,
      "cost_usd_estimate": 2.1080365,
      "produced_outputs": [
        "output/l2-deep-pilot.md"
      ],
      "outputs": [
        {
          "path": "output/l2-deep-pilot.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [
        "l1-methods",
        "l1-models-data",
        "l1-economics",
        "l1-market"
      ],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "l2-deep-defense",
      "type": "research",
      "task": "You are L2 (double-down) researcher in a 2-layer fleet. Context: founder pitching Head of AI at a foundation lab in 2 days — post-training open code models on preference traces from QuickCall (daemon capturing accept/reject/corrections i…",
      "status": "completed",
      "model": "gpt-5.4",
      "turns": 19,
      "tokens": 776077,
      "cost_usd_estimate": 0.7663535,
      "produced_outputs": [
        "output/l2-deep-defense.md"
      ],
      "outputs": [
        {
          "path": "output/l2-deep-defense.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [
        "l1-methods",
        "l1-models-data",
        "l1-economics",
        "l1-market"
      ],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "reading-pack",
      "type": "write",
      "task": "You are the fan-in synthesis node of a 2-layer research fleet. Read all eight research files in the fleet workspace: workers/l1-*/output/l1-*.md and workers/l2-*/output/l2-*.md. Context: founder of QuickCall (daemon capturing preference …",
      "status": "running",
      "model": "gpt-5.4",
      "turns": 0,
      "tokens": 0,
      "cost_usd_estimate": 0,
      "produced_outputs": [],
      "outputs": [
        {
          "path": "output/zero-to-hero.md",
          "kind": "markdown",
          "required": true
        },
        {
          "path": "output/talk-track.md",
          "kind": "markdown",
          "required": true
        }
      ],
      "depends_on": [
        "l2-deep-methods",
        "l2-deep-data",
        "l2-deep-pilot",
        "l2-deep-defense"
      ],
      "iterate": true,
      "worktree": false
    },
    {
      "id": "gap-reviewer",
      "type": "reviewer",
      "task": "You are the review gate of a 2-layer research fleet. Deliverable under review: output/zero-to-hero.md and output/talk-track.md (find in fleet workspace), synthesizing L1 surveys (workers/l1-*/output/) and L2 deep-dives (workers/l2-*/outp…",
      "status": "pending",
      "model": "k3",
      "turns": 0,
      "tokens": 0,
      "cost_usd_estimate": 0,
      "produced_outputs": [],
      "outputs": [
        {
          "path": "output/verdict.md",
          "kind": "verdict",
          "required": true
        }
      ],
      "depends_on": [
        "reading-pack"
      ],
      "iterate": true,
      "worktree": false
    }
  ],
  "edges": [
    {
      "from": "l1-methods",
      "to": "l2-deep-methods"
    },
    {
      "from": "l1-models-data",
      "to": "l2-deep-methods"
    },
    {
      "from": "l1-economics",
      "to": "l2-deep-methods"
    },
    {
      "from": "l1-market",
      "to": "l2-deep-methods"
    },
    {
      "from": "l1-methods",
      "to": "l2-deep-data"
    },
    {
      "from": "l1-models-data",
      "to": "l2-deep-data"
    },
    {
      "from": "l1-economics",
      "to": "l2-deep-data"
    },
    {
      "from": "l1-market",
      "to": "l2-deep-data"
    },
    {
      "from": "l1-methods",
      "to": "l2-deep-pilot"
    },
    {
      "from": "l1-models-data",
      "to": "l2-deep-pilot"
    },
    {
      "from": "l1-economics",
      "to": "l2-deep-pilot"
    },
    {
      "from": "l1-market",
      "to": "l2-deep-pilot"
    },
    {
      "from": "l1-methods",
      "to": "l2-deep-defense"
    },
    {
      "from": "l1-models-data",
      "to": "l2-deep-defense"
    },
    {
      "from": "l1-economics",
      "to": "l2-deep-defense"
    },
    {
      "from": "l1-market",
      "to": "l2-deep-defense"
    },
    {
      "from": "l2-deep-methods",
      "to": "reading-pack"
    },
    {
      "from": "l2-deep-data",
      "to": "reading-pack"
    },
    {
      "from": "l2-deep-pilot",
      "to": "reading-pack"
    },
    {
      "from": "l2-deep-defense",
      "to": "reading-pack"
    },
    {
      "from": "reading-pack",
      "to": "gap-reviewer"
    }
  ],
  "iterations": [],
  "demo": true
}
) as Omit<CanvasPayload, "generated_at">;

export function buildDemoPayload(): CanvasPayload {
  return { ...DEMO_FLEET, generated_at: new Date().toISOString() };
}

export interface SessionEntryView {
  role: string;
  text: string;
}

export interface ActionView {
  type: "tool_call" | "tool_result" | "model_change" | "thinking_level_change" | "complete";
  name?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  stopReason?: string;
  isError?: boolean;
  timestamp?: string;
}

export type TimelineEvent =
  | { type: "message"; role: string; text: string; timestamp?: string }
  | { type: "tool_call"; name: string; arguments?: Record<string, unknown>; timestamp?: string }
  | { type: "tool_result"; toolName?: string; isError?: boolean; text?: string; timestamp?: string }
  | { type: "model_change"; provider: string; modelId: string; timestamp?: string }
  | { type: "thinking_level_change"; thinkingLevel: string; timestamp?: string }
  | { type: "complete"; stopReason: string; timestamp?: string };

export interface SessionTailView {
  entries: SessionEntryView[];
  actions: ActionView[];
  events: TimelineEvent[];
}

function compactToolArguments(value: unknown): unknown {
  if (typeof value === "string") return value.length > 1000 ? `[omitted ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(compactToolArguments);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compactToolArguments(v)]));
  }
  return value;
}

export function parseSessionTail(jsonl: string, maxEntries: number): SessionTailView {
  const events: TimelineEvent[] = [];
  const entries: SessionEntryView[] = [];
  const actions: ActionView[] = [];
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let e: { type?: string; timestamp?: string; message?: { role?: unknown; content?: unknown; stopReason?: string; toolName?: string; isError?: boolean }; provider?: string; modelId?: string; thinkingLevel?: string } | undefined;
    try { e = JSON.parse(raw); } catch { continue; }
    if (!e) continue;
    const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") {
      const a: ActionView = { type: "model_change", provider: e.provider, modelId: e.modelId, timestamp: ts };
      actions.push(a);
      events.push({ type: "model_change", provider: e.provider, modelId: e.modelId, timestamp: ts });
      continue;
    }
    if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
      const a: ActionView = { type: "thinking_level_change", thinkingLevel: e.thinkingLevel, timestamp: ts };
      actions.push(a);
      events.push({ type: "thinking_level_change", thinkingLevel: e.thinkingLevel, timestamp: ts });
      continue;
    }
    if (e.type !== "message") continue;
    const msg = e.message;
    if (!msg || typeof msg.role !== "string" || !Array.isArray(msg.content)) continue;
    // tool result messages carry the result at the message level
    if (msg.role === "toolResult" || msg.role === "tool_result") {
      const a: ActionView = { type: "tool_result", toolName: typeof msg.toolName === "string" ? msg.toolName : undefined, isError: msg.isError, timestamp: ts };
      actions.push(a);
      events.push({ type: "tool_result", toolName: a.toolName, isError: a.isError, timestamp: ts });
    }
    const parts: string[] = [];
    for (const p of msg.content as Array<{ type?: string; text?: string; name?: string; toolName?: string; isError?: boolean; arguments?: Record<string, unknown> }>) {
      if (!p) continue;
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
      else if ((p.type === "toolCall" || p.type === "tool_call") && typeof p.name === "string") {
        parts.push(`[tool: ${p.name}]`);
        const args = compactToolArguments(p.arguments) as Record<string, unknown> | undefined;
        const a: ActionView = { type: "tool_call", name: p.name, arguments: args, timestamp: ts };
        actions.push(a);
        events.push({ type: "tool_call", name: p.name, arguments: args, timestamp: ts });
      } else if (p.type === "toolResult" || p.type === "tool_result") {
        parts.push("[tool result]");
        const a: ActionView = { type: "tool_result", toolName: typeof p.toolName === "string" ? p.toolName : p.name, isError: p.isError, timestamp: ts };
        actions.push(a);
        events.push({ type: "tool_result", toolName: a.toolName, isError: a.isError, timestamp: ts });
      }
    }
    if (msg.stopReason && typeof msg.stopReason === "string" && msg.stopReason !== "toolUse" && msg.stopReason !== "tool_use") {
      const a: ActionView = { type: "complete", stopReason: msg.stopReason, timestamp: ts };
      actions.push(a);
      events.push({ type: "complete", stopReason: msg.stopReason, timestamp: ts });
    }
    const text = parts.join("\n").trim();
    if (text.length > 0) {
      const entry: SessionEntryView = { role: msg.role as string, text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text };
      entries.push(entry);
      events.push({ type: "message", role: entry.role, text: entry.text, timestamp: ts });
    }
  }
  return { entries: entries.slice(-maxEntries), actions: actions.slice(-maxEntries), events: events.slice(-maxEntries) };
}

const DEMO_TASK = `You are L1 (lay-of-the-land) researcher in a 2-layer research fleet.\n\nMission context: founder built QuickCall — a daemon watching engineers' AI coding-agent sessions (Claude Code, Cursor, Codex), extracting team conventions, capturing accept/reject signals and human corrections on agent output.\n\nYour job:\n1. Read the mission brief and upstream inputs.\n2. Search for relevant precedents, code patterns, and competitive landscape.\n3. Write a concise markdown report to the required output path.\n4. Save ALL output files to the worker output directory using absolute paths.\n\nSave the report to output/l1-methods.md. The file must use markdown headings and keep each section focused. Do not modify source code.`;

export function buildDemoSession(_id: string, task?: string): SessionTailView & { task: string } {
  const taskText = task || DEMO_TASK;
  const baseTs = "2026-08-01T09:57:";
  const events: TimelineEvent[] = [
    { type: "model_change", provider: "openai-codex", modelId: "gpt-5.4-mini", timestamp: baseTs + "04.987Z" },
    { type: "thinking_level_change", thinkingLevel: "high", timestamp: baseTs + "04.987Z" },
    { type: "message", role: "assistant", text: "I'll review the scheduler changes and write the verdict.", timestamp: baseTs + "05.000Z" },
    { type: "tool_call", name: "read", arguments: { path: "docs/superpowers/specs/reviewer-contract.md" }, timestamp: baseTs + "06.000Z" },
    { type: "tool_call", name: "read", arguments: { path: "src/scheduler.ts" }, timestamp: baseTs + "06.500Z" },
    { type: "message", role: "assistant", text: "The scheduler uses a priority queue. I'll run the test suite to verify behavior.", timestamp: baseTs + "08.000Z" },
    { type: "tool_call", name: "bash", arguments: { command: "npm run typecheck" }, timestamp: baseTs + "09.000Z" },
    { type: "tool_result", toolName: "bash", isError: false, text: "✓ typecheck passed", timestamp: baseTs + "12.000Z" },
    { type: "message", role: "assistant", text: "Typecheck passes. I'll search for fleet reviewer patterns and inspect tests.", timestamp: baseTs + "12.500Z" },
    { type: "tool_call", name: "web_search", arguments: { queries: ["fleet reviewer DAG pattern"] }, timestamp: baseTs + "13.000Z" },
    { type: "tool_call", name: "read", arguments: { path: "test/scheduler.test.ts" }, timestamp: baseTs + "15.000Z" },
    { type: "tool_result", toolName: "read", isError: false, text: "# 123", timestamp: baseTs + "15.500Z" },
    { type: "message", role: "assistant", text: "Upstream outputs look good. Tests pass and search results confirm the pattern. Writing the review verdict now.", timestamp: baseTs + "17.000Z" },
    { type: "tool_call", name: "write", arguments: { path: "output/review.md" }, timestamp: baseTs + "18.000Z" },
    { type: "tool_result", toolName: "write", isError: false, text: "Successfully wrote 45 bytes to output/review.md", timestamp: baseTs + "18.500Z" },
    { type: "message", role: "assistant", text: "Done.", timestamp: baseTs + "19.000Z" },
    { type: "complete", stopReason: "complete", timestamp: baseTs + "20.000Z" },
  ];
  const entries: SessionEntryView[] = events.filter((e) => e.type === "message").map((e) => ({ role: (e as TimelineEvent & { type: "message" }).role, text: (e as TimelineEvent & { type: "message" }).text }));
  const actions: ActionView[] = events.filter((e) => e.type !== "message").map((e) => {
    if (e.type === "tool_call") return { type: e.type, name: e.name, arguments: e.arguments, timestamp: e.timestamp };
    if (e.type === "tool_result") return { type: e.type, toolName: e.toolName, isError: e.isError, timestamp: e.timestamp };
    if (e.type === "model_change") return { type: e.type, provider: e.provider, modelId: e.modelId, timestamp: e.timestamp };
    if (e.type === "thinking_level_change") return { type: e.type, thinkingLevel: e.thinkingLevel, timestamp: e.timestamp };
    return { type: e.type, stopReason: e.stopReason, timestamp: e.timestamp };
  }) as ActionView[];
  return { entries, actions, events, task: taskText };
}
async function latestSessionFile(workerDir: string): Promise<string | undefined> {
  try {
    const files = (await readdir(workerDir)).filter((f) => f.endsWith(".jsonl")).sort();
    return files.length > 0 ? join(workerDir, files[files.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const requireFrom = createRequire(import.meta.url);

let bundleCache: Promise<string> | undefined;

/** Bundle the React canvas client with esbuild (cached after first build). */
async function buildClientBundle(): Promise<string> {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: [join(HERE, "canvas-client.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    minify: false,
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}

function flowCss(): string {
  try {
    return readFileSyncSafe(requireFrom.resolve("@xyflow/react/dist/style.css"));
  } catch {
    return "";
  }
}
function readFileSyncSafe(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (requireFrom("node:fs") as typeof import("node:fs")).readFileSync(p, "utf-8");
}

const PAGE_CSS = `
:root { color-scheme: dark; --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --line:#30363d; --panel:#171d26; --panel-2:#212936; --stage-bg:#0a0c10; --accent:#58a6ff; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --wire:#6e7681; --hdr:#f0f6fc; --card-shadow:0 1px 2px rgba(0,0,0,0.42), 0 12px 28px -12px rgba(0,0,0,0.72); --card-shadow-lg:0 2px 4px rgba(0,0,0,0.5), 0 18px 42px -14px rgba(0,0,0,0.78); --edge:#4a5361; --edge-soft:#363d49; --mm-mask:rgba(8,10,14,0.55); --mm-frame:rgba(255,255,255,0.14); }
[data-theme="light"] { color-scheme: light; --bg:#f6f8fa; --fg:#1f2328; --muted:#57606a; --line:#d8dee7; --panel:#ffffff; --panel-2:#f6f8fa; --stage-bg:#f2f5f9; --accent:#0969da; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; --wire:#8c959f; --hdr:#1f2328; --card-shadow:0 1px 2px rgba(15,23,42,0.08), 0 14px 30px -16px rgba(15,23,42,0.26); --card-shadow-lg:0 2px 4px rgba(15,23,42,0.10), 0 18px 44px -16px rgba(15,23,42,0.30); --edge:#aeb8c6; --edge-soft:#d0d7de; --mm-mask:rgba(15,23,42,0.10); --mm-frame:rgba(9,105,218,0.35); }
:root { --ui:system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; --mono:"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
* { box-sizing:border-box; }
html,body,#root { margin:0; height:100%; }
html,body { overflow:hidden; font:13px/1.45 var(--ui); background:var(--bg); color:var(--fg); }
/* monospace is reserved for identifiers, code paths, measurements, and transcripts */
.id, .stats, .out-chip, .badge, .fp-name, .fp-status, .fp-trigger-status, .taskbox-side, .msg, .empty code { font-family:var(--mono); }
#root { display:flex; flex-direction:column; }
header { padding:8px 14px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; background:var(--panel); flex:0 0 auto; }
header .name { font-weight:700; color:var(--hdr); }
#hdr { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; min-width:0; }
.pill { padding:1px 8px; border-radius:10px; border:1px solid var(--line); }
button, select { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 11px; min-height:30px; font:inherit; cursor:pointer; }
button:hover, select:hover { border-color:var(--accent); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:6px; }
.icon-btn { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; min-height:30px; padding:0; font-size:18px; line-height:1; color:var(--muted); }
.icon-btn:hover { color:var(--fg); }
.fp { position:relative; }
.fp-trigger { display:flex; align-items:center; gap:7px; min-width:210px; max-width:360px; padding:5px 11px; min-height:30px; text-align:left; }
.fp-trigger-status { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:8px; padding:0 6px; white-space:nowrap; }
.fp-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fp-caret { color:var(--muted); font-size:11px; }
.dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; background:var(--muted); }
.dot.live { background:transparent; border:2px solid var(--accent); }
.fp-menu { position:absolute; top:calc(100% + 6px); left:0; width:340px; max-width:78vw; background:var(--panel); border-radius:12px; box-shadow:var(--card-shadow-lg); z-index:50; overflow:hidden; }
.fp-search { width:100%; border:none; border-bottom:1px solid var(--line); border-radius:0; padding:9px 12px; background:transparent; color:var(--fg); }
.fp-search:focus-visible { outline-offset:-2px; }
.fp-list { max-height:340px; overflow-y:auto; padding:4px 0; }
.fp-item { display:flex; align-items:center; gap:9px; padding:8px 12px; min-height:34px; cursor:pointer; }
.fp-item.active { background:color-mix(in srgb, var(--fg) 8%, transparent); }
.fp-item.selected .fp-name { color:var(--accent); font-weight:600; }
.fp-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fp-status { font-size:11px; color:var(--muted); white-space:nowrap; flex-shrink:0; }
.fp-empty { padding:10px; color:var(--muted); text-align:center; }
.taskbox-side-label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:4px; }
main { display:flex; flex:1 1 auto; min-height:0; }
#stage { flex:1; position:relative; min-width:0; background:var(--stage-bg); }
.react-flow { background:radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--muted) 18%, transparent) 1px, transparent 0) 0 0/24px 24px, var(--stage-bg); }
.react-flow__node { width:304px; }
.react-flow__handle { width:6px; height:6px; background:var(--wire); border:none; opacity:0; }
.react-flow__edge-path { stroke:var(--edge); stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; opacity:0.56; }
.react-flow__edge:hover .react-flow__edge-path { stroke:var(--accent); stroke-width:2.2; opacity:0.95; }
.react-flow__edge.animated .react-flow__edge-path { stroke:var(--accent); stroke-width:2.2; stroke-dasharray:1 8; opacity:0.95; animation:dashflow 0.7s linear infinite; }
@keyframes dashflow { to { stroke-dashoffset:-18; } }
.react-flow__controls button { background:var(--panel); color:var(--fg); border-bottom:1px solid var(--line); fill:var(--fg); }
.react-flow__minimap { width:172px; height:112px; background:var(--panel); border-radius:12px; box-shadow:var(--card-shadow); overflow:hidden; }
.react-flow__minimap svg { border-radius:10px; }
.react-flow__minimap-mask { fill:var(--mm-mask) !important; stroke:none; }
.react-flow__minimap-node { stroke:var(--panel) !important; stroke-width:4px !important; rx:3; ry:3; }
.react-flow__attribution { display:none; }
.node { position:relative; width:304px; border-radius:14px; background:var(--panel); cursor:pointer; box-shadow:var(--card-shadow); overflow:hidden; transition:box-shadow 0.18s ease, transform 0.18s ease, background 0.18s ease; }
.node::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--wire); opacity:0.7; }
.node:hover { box-shadow:var(--card-shadow-lg); transform:translateY(-2px); }
.node.sel { background:color-mix(in srgb, var(--accent) 12%, var(--panel)); box-shadow:var(--card-shadow-lg); transform:translateY(-2px); }
.node.sel.st-failed, .node.sel.st-contract_failed { background:color-mix(in srgb, var(--bad) 12%, var(--panel)); }
/* keyboard focus ring only — never on mouse click */
.node:focus:not(:focus-visible) { outline:none; }
.node.st-running { background:color-mix(in srgb, var(--accent) 8%, var(--panel)); }
.node.st-completed::before { background:var(--ok); }
.node.st-running::before { background:var(--accent); }
.node.st-failed::before, .node.st-contract_failed::before { background:var(--bad); }
.node.st-pending::before, .node.st-ready::before { background:var(--line); }
.node.role-start { box-shadow:var(--card-shadow), inset 0 0 0 1px color-mix(in srgb, var(--ok) 24%, transparent); }
.node.role-end { box-shadow:var(--card-shadow), inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent); }
.node.role-gate { box-shadow:var(--card-shadow), inset 0 0 0 1px color-mix(in srgb, var(--warn) 38%, transparent); }
.node.role-start::after, .node.role-end::after, .node.role-gate::after { content:""; position:absolute; inset:auto 12px 0 12px; height:1px; background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 45%, transparent), transparent); opacity:0.75; }
.node.role-start::after { background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--ok) 45%, transparent), transparent); }
.node.role-gate::after { background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--warn) 55%, transparent), transparent); }
.node.st-failed, .node.st-contract_failed { background:color-mix(in srgb, var(--bad) 9%, var(--panel)); }
.card-body { padding:15px 16px 14px 17px; }
.node-header { display:flex; align-items:center; gap:7px; }
.node-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.node-dot.pulse { animation:pulse 1.6s ease-in-out infinite; }
.node-header .id { flex:1; }
.node-header .badge { margin-left:auto; }
.id { font-weight:760; font-size:16px; letter-spacing:-0.02em; color:var(--hdr); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.badge, .role-badge { font-size:11px; padding:1px 7px; border:1px solid var(--line); border-radius:10px; color:var(--muted); white-space:nowrap; background:color-mix(in srgb, var(--panel-2) 70%, transparent); }
.role-badge { font-weight:700; letter-spacing:0.04em; color:var(--fg); }
.role-start .role-badge { border-color:color-mix(in srgb, var(--ok) 55%, var(--line)); color:var(--ok); }
.role-end .role-badge { border-color:color-mix(in srgb, var(--accent) 55%, var(--line)); color:var(--accent); }
.role-gate .role-badge { border-color:color-mix(in srgb, var(--warn) 60%, var(--line)); color:var(--warn); }
.status-row { margin-top:9px; display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); min-width:0; }
.status-row span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status-row .st-word { color:var(--fg); font-weight:650; }
.spinner { width:10px; height:10px; border:2px solid var(--accent); border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite; display:inline-block; flex-shrink:0; }
@keyframes spin { to { transform:rotate(360deg); } }
.stats { margin-top:6px; font-size:13px; color:var(--muted); }
.outputs { margin-top:10px; display:flex; gap:6px; align-items:center; }
.out-count, .out-chip { display:inline-block; font-size:11px; line-height:1.45; border:1px solid var(--line); border-radius:8px; padding:4px 8px; color:var(--muted); background:var(--bg); }
.out-count { color:var(--fg); background:color-mix(in srgb, var(--accent) 8%, var(--bg)); }
.flags { margin-top:8px; font-size:11px; color:var(--warn); }
.flags span { cursor:help; }
.note { margin-top:6px; font-size:13px; color:var(--warn); }
.note, .fail-reason { user-select:text; cursor:text; }
#side { width:420px; flex:0 0 auto; border-left:1px solid var(--line); overflow:hidden; display:flex; flex-direction:column; background:var(--bg); }
#side:focus, #side:focus-visible { outline:none; }
.side-head { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; flex-shrink:0; gap:6px; padding:12px 12px 8px; border-bottom:1px solid var(--line); background:var(--bg); }
.side-head .side-meta { display:flex; gap:6px; width:100%; }
.side-head .side-meta-chip { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:2px 6px; white-space:nowrap; }
.side-head .meta { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:4px; }
.side-head .side-hash { color:var(--muted); font-weight:400; }
.side-head .side-id { font-weight:700; color:var(--hdr); font-size:15px; letter-spacing:-0.01em; }
.side-body { flex:1; overflow:auto; padding:8px 12px 12px; }
.taskbox-side { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:10px; white-space:pre-wrap; word-break:break-word; font-size:13px; }
.msg { margin-bottom:10px; padding:8px; border-radius:6px; background:var(--panel); white-space:pre-wrap; word-break:break-word; }
.msg .role { font-weight:700; margin-bottom:4px; }
.role-user { color:var(--accent); } .role-assistant { color:var(--ok); } .role-tool { color:var(--warn); }
.collapsible { position:sticky; top:8px; z-index:1; border:1px solid var(--line); border-radius:6px; margin-bottom:10px; background:var(--bg); }
.collapsible-head { display:flex; align-items:center; gap:6px; width:100%; padding:8px; background:transparent; border:none; font:inherit; font-size:12px; color:var(--muted); cursor:pointer; text-align:left; }
.collapsible-head:hover { background:var(--panel); }
.collapsible-body { padding:8px; border-top:1px solid var(--line); white-space:pre-wrap; word-break:break-word; font-size:13px; max-height:260px; overflow:auto; }
.collapsible.collapsed .collapsible-body { display:none; }
.collapsible .chevron { display:inline-block; transition:transform .15s; }
.collapsible.collapsed .chevron { transform:rotate(-90deg); }
.timeline { margin-bottom:12px; }
.timeline-action { background:var(--panel); border-radius:5px; margin-bottom:5px; }
.timeline-action.open { background:var(--panel-2); }
.timeline-action.action-error { box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--bad) 40%, transparent); background:color-mix(in srgb, var(--bad) 9%, var(--panel)); }
.timeline-row { display:flex; align-items:center; gap:8px; padding:5px 8px; font-size:12px; }
.timeline-row .action-icon { flex-shrink:0; width:34px; text-align:center; color:var(--accent); font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:0.02em; }
.timeline-row .action-name { flex-shrink:0; font-weight:600; min-width:48px; font-size:12px; white-space:nowrap; }
.timeline-row .action-detail { flex:1; min-width:0; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.timeline-row .action-error { color:var(--bad); }
.timeline-row .ts { flex-shrink:0; color:var(--wire); font-size:11px; font-variant-numeric:tabular-nums; }
.timeline-msg { padding:4px 8px; margin-bottom:6px; border-radius:5px; background:var(--panel); font-size:13px; }
.timeline-msg.user { border-left:1px solid var(--accent); background:color-mix(in srgb, var(--accent) 5%, var(--panel)); }
.timeline-msg.assistant { border-left:1px solid var(--ok); background:color-mix(in srgb, var(--ok) 5%, var(--panel)); }
.timeline-msg .role { font-weight:700; margin-bottom:4px; }
.timeline-msg .timeline-meta { display:flex; justify-content:space-between; align-items:center; margin-bottom:3px; }
.timeline-msg .timeline-meta .ts { color:var(--wire); font-size:11px; }
.timeline-msg .timeline-text { font-size:12px; line-height:1.45; white-space:pre-wrap; word-break:break-word; user-select:text; }
.timeline-loading { display:flex; align-items:center; justify-content:center; gap:8px; padding:16px 8px; color:var(--muted); font-size:13px; }
.timeline-empty { padding:16px 8px; color:var(--muted); font-size:13px; text-align:center; }
.activity-toggle { flex-shrink:0; width:18px; height:18px; padding:0; background:transparent; border:1px solid var(--line); border-radius:4px; color:var(--muted); cursor:pointer; font-size:11px; line-height:1; }
.activity-toggle:hover { background:var(--bg); color:var(--fg); }
.activity-body { padding:8px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); font-family:var(--mono); white-space:pre-wrap; word-break:break-word; user-select:text; }
.activity-body pre { margin:0; background:var(--bg); padding:8px; border-radius:4px; overflow:auto; font-size:11px; }
.timeline-more { margin-top:4px; padding:0; min-height:auto; border:none; background:none; color:var(--accent); font-size:11px; }
.timeline-more:hover { text-decoration:underline; }
.react-flow__minimap-node.st-completed { fill:var(--ok); }
.react-flow__minimap-node.st-running { fill:var(--accent); }
.react-flow__minimap-node.st-failed, .react-flow__minimap-node.st-contract_failed { fill:var(--bad); }
.react-flow__minimap-node.st-killed, .react-flow__minimap-node.st-blocked { fill:var(--wire); }
.react-flow__minimap-node.st-pending, .react-flow__minimap-node.st-ready { fill:var(--line); }
/* header status strip */
.spacer { flex:1; }
.fleet-title { font-weight:700; font-size:16px; color:var(--hdr); max-width:34ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.stat { display:inline-flex; align-items:center; gap:5px; color:var(--muted); }
.pill.status-running { color:var(--accent); border-color:var(--accent); }
.pill.status-completed { color:var(--ok); border-color:var(--ok); }
.pill.status-failed, .pill.status-contract_failed { color:var(--bad); border-color:var(--bad); }
.pill-bad { color:var(--bad); border-color:var(--bad); }
.pill-btn { display:inline-flex; align-items:center; min-height:24px; cursor:pointer; font:inherit; padding:3px 9px; }
.pill-btn:hover { background:var(--bg); }
.dot-run { background:var(--accent); animation:pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
.conn { display:inline-flex; align-items:center; gap:8px; }
.link-btn { display:inline-flex; align-items:center; min-height:24px; background:none; border:none; padding:2px 8px; color:var(--accent); text-decoration:underline; cursor:pointer; }
button.toggled { border-color:var(--accent); color:var(--accent); }
/* legend */
.legend { position:absolute; left:12px; bottom:12px; z-index:20; min-width:190px; padding:10px 12px; background:var(--panel); border-radius:12px; box-shadow:var(--card-shadow-lg); font-size:13px; }
.legend-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); }
.legend-row { display:flex; align-items:center; gap:9px; padding:2px 0; }
.swatch { width:12px; height:12px; border-radius:3px; flex-shrink:0; background:var(--line); }
.swatch.st-completed { background:var(--ok); }
.swatch.st-running { background:var(--accent); }
.swatch.st-failed { background:var(--bad); }
.swatch.st-blocked { background:var(--wire); }
.swatch.st-pending { background:var(--line); }
.swatch-line { width:16px; height:0; border-top:2px dashed var(--warn); flex-shrink:0; }
.legend-loop { color:var(--warn); margin-top:2px; }
.icon-btn.sm { width:24px; height:24px; min-height:24px; font-size:16px; }
/* empty state */
.empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center; padding:24px; }
.empty-title { font-size:19px; font-weight:700; color:var(--hdr); }
.empty-body { max-width:460px; margin:0; color:var(--muted); }
.empty-steps { max-width:460px; margin:0; text-align:left; color:var(--muted); line-height:1.8; padding-left:18px; }
.empty code { background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
.empty-cta { border-color:var(--accent); color:var(--accent); padding:8px 16px; }
.empty-cta:hover { background:var(--panel); }
/* failure reason surfaced on failed cards */
.fail-reason { margin-top:6px; font-size:13px; color:var(--bad); }
.action-detail { user-select:text; }
/* respect reduced-motion: keep the state, drop the perpetual movement */
@media (prefers-reduced-motion: reduce) {
  .spinner { animation:none; border-top-color:var(--accent); opacity:0.6; }
  .dot-run, .node-dot.pulse { animation:none; }
  .node:hover { transform:none; }
  .react-flow__edge.animated .react-flow__edge-path { animation:none; }
  * { scroll-behavior:auto; }
}
/* narrow viewports: side panel overlays the stage, header controls stay reachable */
@media (max-width:700px) {
  .spacer { display:none; }
  #side { position:absolute; top:0; right:0; bottom:0; width:min(420px,100%); z-index:40; box-shadow:-10px 0 30px rgba(0,0,0,0.45); }
  .fp-trigger { min-width:150px; }
  .legend { bottom:auto; top:12px; }
}
`;

/** Full canvas HTML page with the React/@xyflow bundle inlined. Cached after first build. */
export async function renderCanvasPage(): Promise<string> {
  bundleCache ??= buildClientBundle();
  const [bundle] = await Promise.all([bundleCache]);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>fleet canvas</title>
<style>${flowCss()}</style>
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${bundle}</script>
</body>
</html>`;
}

export interface CanvasServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startCanvasServer(opts: {
  getFleet: () => ActiveFleet | undefined;
  cwd: string;
  port?: number;
}): Promise<CanvasServer> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await renderCanvasPage());
        return;
      }
      if (url.pathname === "/api/demo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(buildDemoPayload()));
        return;
      }
      const resolveFleet = async (name: string | null): Promise<ActiveFleet | undefined | "unknown"> => {
        const live = opts.getFleet();
        if (!name) return live;
        if (live && basename(live.fleetRoot) === name) return live;
        const roots = await listFleetRoots(opts.cwd);
        if (!roots.some((r) => r.name === name)) return "unknown";
        try {
          return await readDiskFleet(join(opts.cwd, ".fleet", name));
        } catch {
          return "unknown";
        }
      };
      if (url.pathname === "/api/fleets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ fleets: await listFleetRoots(opts.cwd) }));
        return;
      }
      if (url.pathname === "/api/state") {
        const f = await resolveFleet(url.searchParams.get("fleet"));
        if (f === "unknown") {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(f ? buildCanvasPayload(f) : { empty: true }));
        return;
      }
      const m = url.pathname.match(/^\/api\/session\/([a-z0-9][a-z0-9-]*)$/);
      if (m) {
        const isDemo = url.searchParams.get("demo") === "1";
        let workerTask: string | undefined;
        if (isDemo) {
          const demo = buildDemoSession(m[1]);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(demo));
          return;
        }
        const f = await resolveFleet(url.searchParams.get("fleet"));
        if (!f || f === "unknown" || !f.spec.workers.some((w) => w.id === m[1])) {
          res.writeHead(404);
          res.end();
          return;
        }
        const rawTail = Number(url.searchParams.get("tail"));
        const tail = Number.isInteger(rawTail) && rawTail > 0 ? Math.min(rawTail, 200) : 30;
        const file = await latestSessionFile(join(f.fleetRoot, "workers", m[1]));
        res.writeHead(200, { "content-type": "application/json" });
        const worker = f.spec.workers.find((w) => w.id === m[1]);
        workerTask = worker?.task;
        if (!file) {
          res.end(JSON.stringify({ entries: [], actions: [], events: [], task: workerTask }));
          return;
        }
        const content = await readFile(file, "utf-8");
        const { entries, actions, events } = parseSessionTail(content, tail);
        res.end(JSON.stringify({ entries, actions, events, task: workerTask }));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  const host = "127.0.0.1";
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    }),
  };
}

export async function openInBrowser(
  url: string,
  runner: (cmd: string, args: string[]) => Promise<void> = async (cmd, args) => { await execFileP(cmd, args); },
): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  try {
    await runner(cmd, args);
  } catch {
    // opener missing/failed — the URL is always shown to the user regardless
  }
}
