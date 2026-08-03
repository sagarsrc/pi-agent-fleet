import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ActiveFleet } from "./controller.js";
import { readState } from "./state.js";
import type { FleetSpec, FleetState } from "./types.js";

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

export function buildDemoPayload(): CanvasPayload {
  return {
    fleet_name: "demo-fleet",
    status: "running",
    created_at: new Date().toISOString(),
    iteration: 2,
    lgtm_streak: 1,
    paused: false,
    cost_usd_estimate: 2.34,
    demo: true,
    config: { max_concurrent: 3, model: "claude", effort: "high" },
    loop: { gate: "reviewer", max_iterations: 5, lgtm_count: 2 },
    nodes: [
      {
        id: "research-a",
        type: "research",
        task: "Research agent A background and surface relevant prior art for the feature.",
        status: "completed",
        model: "gpt-5.4-mini",
        effort: "medium",
        turns: 4,
        tokens: 8200,
        cost_usd_estimate: 0.12,
        produced_outputs: ["output/a.md"],
        outputs: [{ path: "output/a.md", kind: "markdown", required: true }],
        depends_on: [],
        iterate: true,
        worktree: false,
      },
      {
        id: "research-b",
        type: "research",
        task: "Research agent B constraints and compile a list of non-functional requirements.",
        status: "completed",
        model: "gpt-5.4-mini",
        effort: "medium",
        turns: 3,
        tokens: 6400,
        cost_usd_estimate: 0.09,
        produced_outputs: ["output/b.md"],
        outputs: [{ path: "output/b.md", kind: "markdown", required: true }],
        depends_on: [],
        iterate: true,
        worktree: false,
      },
      {
        id: "builder",
        type: "code-run",
        task: "Build the feature using both research outputs and commit the implementation to the worktree branch.",
        status: "running",
        model: "kimi-coding",
        effort: "high",
        turns: 6,
        tokens: 15400,
        cost_usd_estimate: 0.83,
        produced_outputs: [],
        outputs: [{ path: "src/feature.ts", kind: "file-exists", required: true }],
        depends_on: ["research-a", "research-b"],
        iterate: true,
        worktree: true,
      },
      {
        id: "reviewer",
        type: "reviewer",
        task: "Review the implementation for correctness, edge cases, and style consistency.",
        status: "pending",
        model: "claude",
        effort: "high",
        turns: 0,
        tokens: 0,
        cost_usd_estimate: 0,
        produced_outputs: [],
        outputs: [{ path: "output/verdict.md", kind: "verdict", required: true }],
        depends_on: ["builder"],
        iterate: true,
        worktree: false,
      },
    ],
    edges: [
      { from: "research-a", to: "builder" },
      { from: "research-b", to: "builder" },
      { from: "builder", to: "reviewer" },
    ],
    iterations: [
      { n: 1, verdict: "iterate", cost: 1.21, tokens: 21000, duration_ms: 45000 },
      { n: 2, verdict: null, cost: 1.13, tokens: 18000, duration_ms: 32000 },
    ],
    generated_at: new Date().toISOString(),
  };
}

export interface SessionEntryView {
  role: string;
  text: string;
}

export function parseSessionTail(jsonl: string, maxEntries: number): SessionEntryView[] {
  const out: SessionEntryView[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"type":"message"')) continue;
    try {
      const e = JSON.parse(line) as { message?: { role?: unknown; content?: unknown } };
      const msg = e.message;
      if (!msg || typeof msg.role !== "string" || !Array.isArray(msg.content)) continue;
      const parts: string[] = [];
      for (const p of msg.content as Array<{ type?: string; text?: string; name?: string }>) {
        if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
        else if ((p?.type === "toolCall" || p?.type === "tool_call") && typeof p.name === "string") parts.push(`[tool: ${p.name}]`);
        else if (p?.type === "toolResult" || p?.type === "tool_result") parts.push("[tool result]");
      }
      const text = parts.join("\n").trim();
      if (text.length > 0) {
        out.push({ role: msg.role as string, text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text });
      }
    } catch {
      // skip unparseable line
    }
  }
  return out.slice(-maxEntries);
}

async function latestSessionFile(workerDir: string): Promise<string | undefined> {
  try {
    const files = (await readdir(workerDir)).filter((f) => f.endsWith(".jsonl")).sort();
    return files.length > 0 ? join(workerDir, files[files.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

export function renderCanvasPage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>fleet canvas</title>
<style>
:root { color-scheme: dark; --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --line:#30363d; --panel:#161b22; --stage-bg:#0a0c10; --accent:#58a6ff; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --wire:#6e7681; --hdr:#f0f6fc; }
[data-theme="light"] { color-scheme: light; --bg:#f6f8fa; --fg:#1f2328; --muted:#57606a; --line:#d0d7de; --panel:#ffffff; --stage-bg:#f6f8fa; --accent:#0969da; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; --wire:#8c959f; --hdr:#1f2328; }
body.light { color-scheme: light; }
* { box-sizing:border-box; }
html,body { margin:0; height:100%; overflow:hidden; font:13px/1.45 -apple-system, Menlo, monospace; background:var(--bg); color:var(--fg); }
header { padding:8px 14px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; background:var(--panel); }
header .name { font-weight:700; color:var(--hdr); }
#hdr { display:flex; gap:12px; align-items:baseline; }
.pill { padding:1px 8px; border-radius:10px; border:1px solid var(--line); }
button, select { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:3px 10px; font:inherit; cursor:pointer; }
button:hover, select:hover { border-color:var(--accent); }
main { display:flex; height:calc(100% - 42px); }
#stage { flex:1; position:relative; overflow:hidden; background:var(--stage-bg); }
#viewport { position:absolute; left:0; top:0; transform-origin:0 0; }
#toolbar { position:absolute; top:12px; left:12px; display:flex; gap:6px; padding:6px; border:1px solid var(--line); border-radius:8px; background:var(--panel); z-index:10; box-shadow:0 2px 8px rgba(0,0,0,0.25); }
#toolbar button { padding:3px 8px; }
#minimap { position:absolute; right:12px; bottom:12px; width:200px; height:140px; border:1px solid var(--line); border-radius:8px; background:var(--panel); z-index:10; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.25); }
#minimap.hidden { display:none; }
.node { position:absolute; width:260px; border:1px solid var(--line); border-radius:10px; background:var(--panel); cursor:pointer; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.25); transition:border-color 0.15s, box-shadow 0.15s; }
.node:hover { border-color:var(--accent); }
.node.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.accent { height:4px; width:100%; }
.st-completed .accent { background:var(--ok); }
.st-running .accent { background:var(--accent); }
.st-failed .accent, .st-contract_failed .accent { background:var(--bad); }
.st-killed .accent, .st-blocked .accent { background:var(--wire); }
.st-pending .accent, .st-ready .accent { background:var(--line); }
.card-body { padding:10px; }
.node-header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.id { font-weight:700; color:var(--hdr); overflow:hidden; text-overflow:ellipsis; }
.badge { font-size:10px; padding:1px 7px; border:1px solid var(--line); border-radius:10px; color:var(--muted); white-space:nowrap; }
.status-row { margin-top:6px; display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); }
.spinner { width:10px; height:10px; border:2px solid var(--accent); border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite; display:inline-block; flex-shrink:0; }
@keyframes spin { to { transform:rotate(360deg); } }
.stats { margin-top:4px; font-size:12px; color:var(--muted); }
.outputs { margin-top:6px; }
.out-chip { display:inline-block; font-size:10px; border:1px solid var(--line); border-radius:8px; padding:1px 6px; margin:3px 3px 0 0; color:var(--muted); background:var(--bg); }
.flags { margin-top:4px; font-size:10px; color:var(--warn); }
.taskbox { margin-top:8px; padding:8px; border:1px solid var(--line); border-radius:6px; font-size:12px; color:var(--fg); white-space:pre-wrap; word-break:break-word; max-height:120px; overflow:auto; }
.note { margin-top:6px; font-size:12px; color:var(--warn); }
.session-preview { margin-top:8px; padding:6px; border:1px solid var(--line); border-radius:6px; background:var(--bg); }
.session-preview .caption { font-size:10px; color:var(--muted); margin-bottom:4px; }
.session-preview .role { font-weight:700; font-size:11px; }
.session-preview .msg { font-size:11px; color:var(--muted); white-space:pre-wrap; word-break:break-word; max-height:80px; overflow:hidden; }
#side { width:420px; border-left:1px solid var(--line); overflow:auto; padding:12px; display:none; background:var(--bg); }
#side.open { display:block; }
#side .meta { color:var(--muted); margin-bottom:8px; }
.taskbox-side { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:10px; white-space:pre-wrap; word-break:break-word; font-size:12px; }
.msg { margin-bottom:10px; padding:8px; border-radius:6px; background:var(--panel); white-space:pre-wrap; word-break:break-word; }
.msg .role { font-weight:700; margin-bottom:4px; }
.role-user { color:var(--accent); } .role-assistant { color:var(--ok); } .role-tool { color:var(--warn); }
#empty { padding:40px; color:var(--muted); }
.map-node { rx:2; ry:2; }
.st-completed.map-node { fill:var(--ok); }
.st-running.map-node { fill:var(--accent); }
.st-failed.map-node, .st-contract_failed.map-node { fill:var(--bad); }
.st-killed.map-node, .st-blocked.map-node { fill:var(--wire); }
.st-pending.map-node, .st-ready.map-node { fill:var(--line); }
.map-viewport { fill:rgba(88,166,255,0.12); stroke:var(--accent); stroke-width:1; }
</style>
</head>
<body>
<header>
  <span class="name">fleet canvas</span>
  <select id="fleetSel"></select>
  <span id="hdr"></span>
  <span style="flex:1"></span>
  <button onclick="toggleTheme()">theme</button>
</header>
<main>
<div id="stage">
  <div id="toolbar">
    <button onclick="zoomAt(stage.clientWidth/2, stage.clientHeight/2, 1.2)" title="zoom in">+</button>
    <button onclick="zoomAt(stage.clientWidth/2, stage.clientHeight/2, 1/1.2)" title="zoom out">-</button>
    <button onclick="fitView()">fit</button>
    <button onclick="resetView()">1:1</button>
    <button onclick="toggleTheme()">theme</button>
    <button id="mapBtn" onclick="toggleMinimap()">map</button>
    <button onclick="toggleDemo()">demo</button>
  </div>
  <div id="minimap"><svg id="mapSvg" width="100%" height="100%"></svg></div>
  <div id="viewport"></div>
</div>
<div id="side"></div>
</main>
<script>
var MIN_ZOOM = 0.2, MAX_ZOOM = 2.5;
var camera = { x: 40, y: 40, scale: 1 };
var selected = null;
var currentFleet = null;
var isDemo = false;
var expandedNodes = new Set();
var stage, viewport, minimap, mapSvg;
var lastPayload = null;

function $(id){ return document.getElementById(id); }
function j(u){ return fetch(u).then(function(r){ if(!r.ok) throw new Error(String(r.status)); return r.json(); }); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]; }); }

/* theme */
function currentTheme(){ return document.documentElement.getAttribute("data-theme") || "dark"; }
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  document.body.className = t;
  try { localStorage.setItem("fleet-canvas-theme", t); } catch(e){}
}
function toggleTheme(){
  var t = currentTheme() === "light" ? "dark" : "light";
  applyTheme(t);
  updateSearchParam("theme", t);
}
function updateSearchParam(key, value){
  var u = new URL(location.href);
  if(value) u.searchParams.set(key, value);
  else u.searchParams.delete(key);
  history.replaceState(null, "", u.toString());
}
(function(){
  var qs = new URLSearchParams(location.search);
  var t = qs.get("theme");
  if(t !== "light" && t !== "dark"){
    try { t = localStorage.getItem("fleet-canvas-theme"); } catch(e){}
    if(t !== "light" && t !== "dark" && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) t = "light";
  }
  applyTheme(t === "light" || t === "dark" ? t : "dark");
})();

/* demo */
function initDemo(){
  var qs = new URLSearchParams(location.search);
  isDemo = qs.get("demo") === "1";
}
function toggleDemo(){
  isDemo = !isDemo;
  updateSearchParam("demo", isDemo ? "1" : null);
  selected = null;
  $("side").classList.remove("open");
  tick();
}

/* camera */
function applyCamera(){
  viewport.style.transform = "translate(" + camera.x + "px," + camera.y + "px) scale(" + camera.scale + ")";
  updateMapViewport();
}
function screenToWorld(sx, sy){ return { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale }; }
function zoomAt(sx, sy, factor){
  var p = screenToWorld(sx, sy);
  camera.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.scale * factor));
  camera.x = sx - p.x * camera.scale;
  camera.y = sy - p.y * camera.scale;
  applyCamera();
}
stage = $("stage");
viewport = document.createElement("div");
viewport.id = "viewport";
stage.appendChild(viewport);
mapSvg = $("mapSvg");
minimap = $("minimap");

var dragging = false, lastX = 0, lastY = 0;
stage.addEventListener("wheel", function(e){
  e.preventDefault();
  var r = stage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
stage.addEventListener("pointerdown", function(e){
  if(e.target.closest && e.target.closest(".node")) return;
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", function(e){
  if(!dragging) return;
  camera.x += e.clientX - lastX;
  camera.y += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyCamera();
});
stage.addEventListener("pointerup", function(){ dragging = false; });
function fitView(){
  var els = viewport.querySelectorAll(".node");
  if(!els.length) return;
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  els.forEach(function(el){
    var x = el.offsetLeft, y = el.offsetTop;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + el.offsetWidth); maxY = Math.max(maxY, y + el.offsetHeight);
  });
  var pad = 60;
  var sw = stage.clientWidth - pad * 2, sh = stage.clientHeight - pad * 2;
  var z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(sw / (maxX - minX), sh / (maxY - minY))));
  camera.scale = z;
  camera.x = pad - minX * z + (sw - (maxX - minX) * z) / 2;
  camera.y = pad - minY * z + (sh - (maxY - minY) * z) / 2;
  applyCamera();
}
function resetView(){ camera = { x: 40, y: 40, scale: 1 }; applyCamera(); }

/* layout */
function topoLayers(nodes, edges){
  var ids = nodes.map(function(n){ return n.id; });
  var indeg = {}, rev = {};
  ids.forEach(function(i){ indeg[i] = 0; rev[i] = []; });
  edges.forEach(function(e){ if(e.from in indeg){ indeg[e.to]++; rev[e.from].push(e.to); } });
  var layers = [], cur = ids.filter(function(i){ return indeg[i] === 0; }), seen = {};
  while(cur.length){
    layers.push(cur);
    cur.forEach(function(i){ seen[i] = true; });
    var next = [];
    cur.forEach(function(i){
      rev[i].forEach(function(m){
        indeg[m]--;
        if(indeg[m] === 0) next.push(m);
      });
    });
    cur = next;
  }
  ids.forEach(function(i){ if(!seen[i]){ layers.push([i]); seen[i] = true; } });
  return layers;
}
function median(arr){
  var s = arr.slice().sort(function(a,b){ return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function reduceCrossings(layers, edges){
  for(var li = 1; li < layers.length; li++){
    var prev = layers[li - 1];
    var prevPos = {};
    prev.forEach(function(id, i){ prevPos[id] = i; });
    layers[li].sort(function(a, b){
      var pa = edges.filter(function(e){ return e.to === a; }).map(function(e){ return prevPos[e.from] == null ? 0 : prevPos[e.from]; });
      var pb = edges.filter(function(e){ return e.to === b; }).map(function(e){ return prevPos[e.from] == null ? 0 : prevPos[e.from]; });
      return median(pa) - median(pb);
    });
  }
  return layers;
}
function layout(s){
  var layers = reduceCrossings(topoLayers(s.nodes, s.edges), s.edges);
  var pos = {};
  layers.forEach(function(layer, li){
    layer.forEach(function(id, ni){
      pos[id] = { x: li * 320, y: ni * 140 };
    });
  });
  return pos;
}

/* render */
function statusClass(s){ return "st-" + s.replace(/\s+/g, "_"); }
function nodeHtml(n){
  var isRunning = n.status === "running";
  var chips = (n.outputs || []).map(function(o){
    return '<span class="out-chip">' + esc(o.path) + " · " + esc(o.kind) + '</span>';
  }).join("");
  var flags = [];
  if(n.iterate === false) flags.push("once");
  if(n.worktree) flags.push("worktree");
  var expanded = expandedNodes.has(n.id);
  var html = '<div class="accent"></div><div class="card-body">'
    + '<div class="node-header"><span class="id">' + esc(n.id) + '</span><span class="badge">' + esc(n.type) + '</span></div>'
    + '<div class="status-row">'
    + (isRunning ? '<span class="spinner"></span>' : '')
    + '<span>' + esc(n.status) + '</span>'
    + (n.effort ? '<span>·</span><span>' + esc(n.effort) + '</span>' : '')
    + '<span>·</span><span>' + esc(n.model) + '</span></div>'
    + '<div class="stats">' + (n.turns | 0) + ' turns · ' + (Number(n.tokens || 0) / 1000).toFixed(1) + 'k tok · $' + Number(n.cost_usd_estimate || 0).toFixed(2) + '</div>'
    + (chips ? '<div class="outputs">' + chips + '</div>' : "")
    + (flags.length ? '<div class="flags">' + flags.join(" · ") + '</div>' : "")
    + (n.status_note ? '<div class="note">' + esc(n.status_note) + '</div>' : "");
  if(expanded){
    html += '<div class="taskbox">' + esc(n.task) + '</div>'
      + '<div class="session-preview"><div class="caption">last session preview</div><div class="body">loading…</div></div>';
  }
  html += '</div>';
  return html;
}
function renderNodes(s, pos, byId){
  s.nodes.forEach(function(n){
    var el = document.createElement("div");
    el.className = "node " + (expandedNodes.has(n.id) ? "expanded" : "collapsed") + " " + statusClass(n.status) + (selected === n.id ? " sel" : "");
    el.setAttribute("data-id", n.id);
    el.style.left = pos[n.id].x + "px";
    el.style.top = pos[n.id].y + "px";
    el.innerHTML = nodeHtml(n);
    el.onclick = function(e){ e.stopPropagation(); sel(n.id); toggleExpand(n.id); };
    viewport.appendChild(el);
    n._lx = pos[n.id].x;
    n._ly = pos[n.id].y;
    n._el = el;
    byId[n.id] = n;
  });
}
function renderEdges(s, byId, svg){
  svg.innerHTML = '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--wire)" /></marker></defs>';
  s.edges.forEach(function(e){
    var a = byId[e.from], b = byId[e.to];
    if(!a || !b) return;
    var x1 = a._lx + a._el.offsetWidth;
    var y1 = a._ly + a._el.offsetHeight / 2;
    var x2 = b._lx;
    var y2 = b._ly + b._el.offsetHeight / 2;
    var dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M " + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "var(--wire)");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("marker-end", "url(#arrow)");
    svg.appendChild(p);
  });
}
function render(s){
  lastPayload = s;
  var pos = layout(s);
  viewport.innerHTML = "";
  var byId = {};
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.width = "1";
  svg.style.height = "1";
  svg.style.pointerEvents = "none";
  svg.style.overflow = "visible";
  viewport.appendChild(svg);
  renderNodes(s, pos, byId);
  renderEdges(s, byId, svg);
  updateMinimap();
  fillSessionPreviews();
}
function toggleExpand(id){
  if(expandedNodes.has(id)) expandedNodes.delete(id);
  else expandedNodes.add(id);
  if(lastPayload) render(lastPayload);
}

/* minimap */
function updateMinimap(){
  if(minimap.classList.contains("hidden")) return;
  var els = viewport.querySelectorAll(".node");
  if(!els.length){ mapSvg.innerHTML = ""; return; }
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  els.forEach(function(el){
    var x = el.offsetLeft, y = el.offsetTop;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + el.offsetWidth); maxY = Math.max(maxY, y + el.offsetHeight);
  });
  var pad = 6;
  var mw = minimap.clientWidth - pad * 2, mh = minimap.clientHeight - pad * 2;
  var scale = Math.min(mw / (maxX - minX), mh / (maxY - minY));
  var ox = pad + (mw - (maxX - minX) * scale) / 2 - minX * scale;
  var oy = pad + (mh - (maxY - minY) * scale) / 2 - minY * scale;
  var html = "";
  els.forEach(function(el){
    var st = "";
    for(var i = 0; i < el.classList.length; i++){
      var c = el.classList[i];
      if(c.indexOf("st-") === 0){ st = c; break; }
    }
    html += '<rect class="map-node ' + st + '" x="' + (el.offsetLeft * scale + ox) + '" y="' + (el.offsetTop * scale + oy) + '" width="' + (el.offsetWidth * scale) + '" height="' + (el.offsetHeight * scale) + '" />';
  });
  var vx = -camera.x / camera.scale, vy = -camera.y / camera.scale;
  var vw = stage.clientWidth / camera.scale, vh = stage.clientHeight / camera.scale;
  html += '<rect class="map-viewport" x="' + (vx * scale + ox) + '" y="' + (vy * scale + oy) + '" width="' + (vw * scale) + '" height="' + (vh * scale) + '" />';
  mapSvg.innerHTML = html;
}
function updateMapViewport(){ updateMinimap(); }
function toggleMinimap(){ minimap.classList.toggle("hidden"); updateMinimap(); }

/* session previews inside expanded nodes */
function fillSessionPreviews(){
  if(isDemo) return;
  expandedNodes.forEach(function(id){
    var box = document.querySelector('.node[data-id="' + id + '"] .session-preview .body');
    if(!box) return;
    j("/api/session/" + id + "?tail=1" + sessionParam()).then(function(r){
      var html = "";
      if(r.entries && r.entries.length){
        var e = r.entries[r.entries.length - 1];
        html = '<div class="role role-' + esc(e.role) + '">' + esc(e.role) + '</div><div class="msg">' + esc(e.text.length > 160 ? e.text.slice(0, 160) + "…" : e.text) + '</div>';
      } else {
        html = '<div class="msg">No recent entries.</div>';
      }
      box.innerHTML = html;
    }).catch(function(){
      box.innerHTML = '<div class="msg">Session unavailable.</div>';
    });
  });
}

/* data */
function fleetParam(){ return currentFleet ? "?fleet=" + encodeURIComponent(currentFleet) : ""; }
function sessionParam(){ return currentFleet ? "&fleet=" + encodeURIComponent(currentFleet) : ""; }
function apiUrl(){ return isDemo ? "/api/demo" : "/api/state" + fleetParam(); }
function renderHeader(s){
  var hdr = $("hdr");
  if(s.empty){
    hdr.innerHTML = '<span class="pill">no live fleet</span>';
    return;
  }
  var loop = s.loop ? " · iter " + s.iteration + "/" + s.loop.max_iterations + " · streak " + s.lgtm_streak : "";
  var done = s.nodes.filter(function(n){ return n.status === "completed"; }).length;
  hdr.innerHTML = '<span class="name">' + esc(s.fleet_name) + '</span>'
    + (s.demo ? '<span class="pill">demo</span>' : '')
    + '<span class="pill">' + esc(s.status) + '</span>'
    + (s.paused ? '<span class="pill">paused</span>' : '')
    + '<span>' + done + '/' + s.nodes.length + ' done</span>'
    + '<span>$' + s.cost_usd_estimate.toFixed(2) + '</span>'
    + '<span class="meta">' + esc(loop) + '</span>';
}
function tick(){
  j(apiUrl()).then(function(s){
    if(s.empty){
      renderHeader(s);
      viewport.innerHTML = "";
      updateMinimap();
      return;
    }
    renderHeader(s);
    render(s);
  }).catch(function(){
    if(currentFleet && !isDemo){
      $("hdr").innerHTML = '<span class="pill">fleet unavailable</span>';
      currentFleet = null;
      $("fleetSel").value = "";
      try { localStorage.removeItem("fleet-canvas-fleet"); } catch(e){}
      tick();
    } else {
      $("hdr").innerHTML = '<span class="pill">connection lost</span>';
    }
  });
}
function side(){
  if(!selected) return;
  j("/api/session/" + selected + "?tail=30" + sessionParam()).then(function(r){
    var el = $("side");
    var sst = el.scrollTop;
    var taskHtml = "";
    if(r.task) taskHtml = '<div class="taskbox-side">' + esc(r.task) + '</div>';
    el.innerHTML = '<div class="meta"># ' + esc(selected) + ' - session</div>'
      + taskHtml
      + (r.entries || []).map(function(e){
          return '<div class="msg"><div class="role role-' + esc(e.role) + '">' + esc(e.role) + '</div>' + esc(e.text) + '</div>';
        }).join("");
    el.scrollTop = sst;
  }).catch(function(){});
}
function sel(id){
  selected = id;
  $("side").classList.add("open");
  if(lastPayload) render(lastPayload);
  side();
}

/* fleet picker */
function loadFleets(){
  j("/api/fleets").then(function(r){
    var selEl = $("fleetSel");
    var opts = ['<option value="">live fleet</option>'];
    r.fleets.forEach(function(f){
      opts.push('<option value="' + esc(f.name) + '">' + esc(f.name) + ' (' + esc(f.status) + ')</option>');
    });
    selEl.innerHTML = opts.join("");
    var qs = new URLSearchParams(location.search);
    var want = qs.get("fleet");
    var saved = "";
    try { saved = localStorage.getItem("fleet-canvas-fleet") || ""; } catch(e){}
    var pick = want || saved || "";
    if(pick && r.fleets.some(function(f){ return f.name === pick; })){
      currentFleet = pick;
      selEl.value = pick;
    }
    tick();
    var pre = qs.get("node");
    if(pre) sel(pre);
  }).catch(function(){
    tick();
    var qs = new URLSearchParams(location.search);
    var pre = qs.get("node");
    if(pre) sel(pre);
  });
}
$("fleetSel").addEventListener("change", function(e){
  currentFleet = e.target.value || null;
  try { localStorage.setItem("fleet-canvas-fleet", currentFleet || ""); } catch(err){}
  selected = null;
  $("side").classList.remove("open");
  tick();
});

/* keyboard shortcuts */
window.addEventListener("keydown", function(e){
  if(e.target.matches("input,select,textarea")) return;
  if(e.key === "f"){ e.preventDefault(); fitView(); }
  else if(e.key === "0"){ e.preventDefault(); resetView(); }
  else if(e.key === "t"){ e.preventDefault(); toggleTheme(); }
  else if(e.key === "d"){ e.preventDefault(); toggleDemo(); }
});

initDemo();
loadFleets();
setInterval(tick, 1500);
setInterval(side, 2000);
</script>
</body>
</html>`;
}

export interface FleetRootInfo {
  name: string;
  root: string;
  status: string;
  created_at: string;
}

export async function readDiskFleet(fleetRoot: string): Promise<ActiveFleet> {
  const spec = JSON.parse(await readFile(join(fleetRoot, "fleet.json"), "utf-8")) as FleetSpec;
  const state = await readState(fleetRoot);
  return {
    spec,
    fleetRoot,
    state,
    killSwitch: { killed: false },
    pauseSwitch: { paused: false },
    running: false,
    sessions: new Map(),
    killedNodes: new Set(),
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
        res.end(renderCanvasPage());
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
        if (!file) {
          res.end(JSON.stringify({ entries: [], task: worker?.task }));
          return;
        }
        const content = await readFile(file, "utf-8");
        res.end(JSON.stringify({ entries: parseSessionTail(content, tail), task: worker?.task }));
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
