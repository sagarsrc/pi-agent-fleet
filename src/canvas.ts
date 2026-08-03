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
:root { color-scheme: dark; }
body {
  --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --line:#30363d; --panel:#161b22;
  --accent:#58a6ff; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --wire:#6e7681; --hdr:#f0f6fc;
}
body.light { color-scheme: light;
  --bg:#f6f8fa; --fg:#1f2328; --muted:#57606a; --line:#d0d7de; --panel:#ffffff;
  --accent:#0969da; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; --wire:#8c959f; --hdr:#1f2328;
}
* { box-sizing:border-box; }
body { margin:0; font:13px/1.45 -apple-system, Menlo, monospace; background:var(--bg); color:var(--fg); }
header { padding:8px 14px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
header .name { font-weight:700; color:var(--hdr); }
#hdr { display:flex; gap:12px; align-items:baseline; }
.pill { padding:1px 8px; border-radius:10px; border:1px solid var(--line); }
button, select { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:3px 10px; font:inherit; cursor:pointer; }
button:hover, select:hover { border-color:var(--accent); }
main { display:flex; height:calc(100vh - 42px); }
#stage { flex:1; position:relative; overflow:hidden; }
#viewport { position:absolute; left:0; top:0; transform-origin:0 0; }
.node { position:absolute; width:260px; border:1px solid var(--line); border-radius:8px; padding:8px 10px; cursor:pointer; background:var(--panel); }
.node:hover { border-color:var(--accent); }
.node.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.node .nid { font-weight:700; color:var(--hdr); }
.badge { float:right; font-size:10px; padding:0 6px; border:1px solid var(--line); border-radius:8px; color:var(--muted); }
.meta { color:var(--muted); font-size:12px; }
.stats { font-size:12px; margin-top:2px; }
.note { color:var(--warn); font-size:12px; margin-top:4px; }
.out-chip { display:inline-block; font-size:10px; border:1px solid var(--line); border-radius:8px; padding:0 5px; margin:3px 3px 0 0; color:var(--muted); }
.flags { font-size:10px; color:var(--warn); margin-top:3px; }
.st-completed { border-left:4px solid var(--ok); }
.st-running { border-left:4px solid var(--accent); }
.st-failed, .st-contract_failed { border-left:4px solid var(--bad); }
.st-killed, .st-blocked { border-left:4px solid var(--muted); }
.st-pending, .st-ready { border-left:4px solid var(--line); }
#side { width:430px; border-left:1px solid var(--line); overflow:auto; padding:12px; display:none; background:var(--bg); }
#side.open { display:block; }
.msg { margin-bottom:10px; padding:8px; border-radius:6px; background:var(--panel); white-space:pre-wrap; word-break:break-word; }
.msg .role { font-weight:700; margin-bottom:4px; }
.role-user { color:var(--accent); } .role-assistant { color:var(--ok); } .role-tool { color:var(--warn); }
.taskbox { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:10px; white-space:pre-wrap; word-break:break-word; font-size:12px; }
#empty { padding:40px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <span class="name">fleet canvas</span>
  <select id="fleetSel"></select>
  <span id="hdr"></span>
  <span style="flex:1"></span>
  <button onclick="fitView()">fit</button>
  <button onclick="resetView()">1:1</button>
  <button id="themeBtn" onclick="toggleTheme()">theme</button>
</header>
<main>
<div id="stage"></div>
<div id="side"></div>
</main>
<script>
var MIN_ZOOM = 0.2, MAX_ZOOM = 2.5;
var camera = { x: 40, y: 40, scale: 1 };
var selected = null;
var currentFleet = null;
var stage = document.getElementById("stage");
var viewport = document.createElement("div");
viewport.id = "viewport";
stage.appendChild(viewport);

function j(u){ return fetch(u).then(function(r){ if(!r.ok) throw new Error(String(r.status)); return r.json(); }); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]; }); }

/* theme */
function applyTheme(t){
  document.body.className = t === "light" ? "light" : "";
  try { localStorage.setItem("fleet-canvas-theme", t); } catch(e) {}
}
function toggleTheme(){
  applyTheme(document.body.className === "light" ? "dark" : "light");
}
(function(){
  var qsTheme = new URLSearchParams(location.search).get("theme");
  var t = qsTheme === "light" || qsTheme === "dark" ? qsTheme : null;
  try { if(!t) t = localStorage.getItem("fleet-canvas-theme"); } catch(e) {}
  if(!t && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) t = "light";
  applyTheme(t || "dark");
})();

/* camera */
function applyCamera(){
  viewport.style.transform = "translate(" + camera.x + "px," + camera.y + "px) scale(" + camera.scale + ")";
}
function screenToWorld(sx, sy){ return { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale }; }
function zoomAt(sx, sy, factor){
  var p = screenToWorld(sx, sy);
  camera.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.scale * factor));
  camera.x = sx - p.x * camera.scale;
  camera.y = sy - p.y * camera.scale;
  applyCamera();
}
stage.addEventListener("wheel", function(e){
  e.preventDefault();
  var r = stage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
var dragging = false, lastX = 0, lastY = 0;
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
  var sw = stage.clientWidth - 60, sh = stage.clientHeight - 60;
  var z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(sw / (maxX - minX), sh / (maxY - minY))));
  camera.scale = z;
  camera.x = 30 - minX * z + (sw - (maxX - minX) * z) / 2;
  camera.y = 30 - minY * z + (sh - (maxY - minY) * z) / 2;
  applyCamera();
}
function resetView(){ camera = { x: 40, y: 40, scale: 1 }; applyCamera(); }

/* layout */
function layers(nodes, edges){
  var ids = nodes.map(function(n){ return n.id; });
  var indeg = {}; var rev = {};
  ids.forEach(function(i){ indeg[i]=0; rev[i]=[]; });
  edges.forEach(function(e){ if(e.from in indeg){ indeg[e.to]++; rev[e.from].push(e.to); } });
  var out=[]; var cur=ids.filter(function(i){ return indeg[i]===0; }); var seen={};
  while(cur.length){
    out.push(cur);
    cur.forEach(function(i){ seen[i]=true; });
    var next=[];
    cur.forEach(function(i){ rev[i].forEach(function(m){ indeg[m]--; if(indeg[m]===0) next.push(m); }); });
    cur=next.filter(function(i){ return !seen[i]; });
  }
  ids.forEach(function(i){ if(!seen[i]) out.push([i]); });
  return out;
}
function layout(s){
  var L = layers(s.nodes, s.edges);
  var pos = {};
  L.forEach(function(layer, li){
    layer.forEach(function(id, ni){
      pos[id] = { x: li * 340, y: ni * 160 };
    });
  });
  return pos;
}

/* render */
function cardHtml(n){
  var chips = (n.outputs || []).map(function(o){
    return '<span class="out-chip">' + esc(o.path) + " · " + esc(o.kind) + '</span>';
  }).join("");
  var flags = [];
  if(n.iterate === false) flags.push("once");
  if(n.worktree) flags.push("worktree");
  return '<div class="nid">' + esc(n.id) + '<span class="badge">' + esc(n.type) + '</span></div>'
    + '<div class="meta">' + esc(n.status) + ' · ' + esc(n.model) + (n.effort ? " · " + esc(n.effort) : "") + '</div>'
    + '<div class="stats">' + String(n.turns|0) + ' turns · ' + (Number(n.tokens||0)/1000).toFixed(1) + 'k tok · $' + Number(n.cost_usd_estimate||0).toFixed(2) + '</div>'
    + (chips ? '<div>' + chips + '</div>' : "")
    + (flags.length ? '<div class="flags">' + flags.join(" · ") + '</div>' : "")
    + (n.status_note ? '<div class="note">' + esc(n.status_note) + '</div>' : "");
}
function render(s){
  var pos = layout(s);
  viewport.innerHTML = "";
  var byId = {};
  s.nodes.forEach(function(n){
    var el = document.createElement("div");
    el.className = "node st-" + n.status + (selected === n.id ? " sel" : "");
    el.setAttribute("data-id", n.id);
    el.style.left = pos[n.id].x + "px";
    el.style.top = pos[n.id].y + "px";
    el.innerHTML = cardHtml(n);
    el.onclick = function(){ sel(n.id); };
    viewport.appendChild(el);
    n._lx = pos[n.id].x; n._ly = pos[n.id].y; n._el = el;
    byId[n.id] = n;
  });
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.position = "absolute";
  svg.style.left = "0"; svg.style.top = "0";
  svg.style.pointerEvents = "none";
  svg.style.overflow = "visible";
  svg.setAttribute("width", "1"); svg.setAttribute("height", "1");
  s.edges.forEach(function(e){
    var a = byId[e.from], b = byId[e.to];
    if(!a || !b) return;
    var x1 = a._lx + 260;
    var y1 = a._ly + (a._el ? a._el.offsetHeight : 110) / 2;
    var x2 = b._lx;
    var y2 = b._ly + (b._el ? b._el.offsetHeight : 110) / 2;
    var mx = (x1 + x2) / 2;
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "var(--wire)");
    p.setAttribute("stroke-width", "2");
    svg.appendChild(p);
    var ah = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ah.setAttribute("d", "M " + (x2-7) + " " + (y2-4.5) + " L " + x2 + " " + y2 + " L " + (x2-7) + " " + (y2+4.5));
    ah.setAttribute("fill", "none");
    ah.setAttribute("stroke", "var(--wire)");
    ah.setAttribute("stroke-width", "2");
    svg.appendChild(ah);
  });
  viewport.appendChild(svg);
}

/* data */
function fleetParam(){ return currentFleet ? "?fleet=" + encodeURIComponent(currentFleet) : ""; }
function sessionParam(){ return currentFleet ? "&fleet=" + encodeURIComponent(currentFleet) : ""; }
function tick(){
  j("/api/state" + fleetParam()).then(function(s){
    var hdr = document.getElementById("hdr");
    if(s.empty){
      hdr.textContent = "no live fleet";
      viewport.innerHTML = "";
      return;
    }
    var loop = s.loop ? " · iter " + s.iteration + "/" + s.loop.max_iterations + " · streak " + s.lgtm_streak : "";
    var done = s.nodes.filter(function(n){ return n.status==="completed"; }).length;
    hdr.innerHTML = '<span class="name">' + esc(s.fleet_name) + '</span>'
      + '<span class="pill">' + esc(s.status) + '</span>'
      + (s.paused ? '<span class="pill">paused</span>' : '')
      + '<span>' + done + '/' + s.nodes.length + ' done</span>'
      + '<span>$' + s.cost_usd_estimate.toFixed(2) + '</span>'
      + '<span class="meta">' + esc(loop) + '</span>';
    render(s);
  }).catch(function(){
    if(currentFleet){
      document.getElementById("hdr").innerHTML = '<span class="pill">fleet unavailable</span>';
      currentFleet = null;
      document.getElementById("fleetSel").value = "";
      try { localStorage.removeItem("fleet-canvas-fleet"); } catch(e){}
      setTimeout(function(){ tick(); }, 0);
    } else {
      document.getElementById("hdr").innerHTML = '<span class="pill">connection lost</span>';
    }
  });
}
function side(){
  if(!selected) return;
  j("/api/session/" + selected + "?tail=30" + sessionParam()).then(function(r){
    var el = document.getElementById("side");
    var sst = el.scrollTop;
    var taskHtml = "";
    if(r.task) taskHtml = '<div class="taskbox">' + esc(r.task) + '</div>';
    el.innerHTML = '<div class="meta"># ' + esc(selected) + ' - session</div>'
      + taskHtml
      + r.entries.map(function(e){
          return '<div class="msg"><div class="role role-' + esc(e.role) + '">' + esc(e.role) + '</div>' + esc(e.text) + '</div>';
        }).join("");
    el.scrollTop = sst;
  }).catch(function(){});
}
function sel(id){
  selected = id;
  document.getElementById("side").classList.add("open");
  viewport.querySelectorAll(".node").forEach(function(el){
    el.className = el.className.replace(" sel", "") + (el.getAttribute("data-id") === id ? " sel" : "");
  });
  side();
}

/* fleet picker */
function loadFleets(){
  j("/api/fleets").then(function(r){
    var selEl = document.getElementById("fleetSel");
    var opts = ['<option value="">live fleet</option>'];
    r.fleets.forEach(function(f){
      opts.push('<option value="' + esc(f.name) + '">' + esc(f.name) + ' (' + esc(f.status) + ')</option>');
    });
    selEl.innerHTML = opts.join("");
    var qs = new URLSearchParams(location.search);
    var want = qs.get("fleet");
    var saved = null;
    try { saved = localStorage.getItem("fleet-canvas-fleet"); } catch(e) {}
    var pick = want || saved || "";
    if(pick && r.fleets.some(function(f){ return f.name === pick; })){
      currentFleet = pick;
      selEl.value = pick;
    }
    tick();
    var qs = new URLSearchParams(location.search);
    var pre = qs.get("node");
    if(pre) sel(pre);
  }).catch(function(){
    tick();
    var qs = new URLSearchParams(location.search);
    var pre = qs.get("node");
    if(pre) sel(pre);
  });
}
document.getElementById("fleetSel").addEventListener("change", function(e){
  currentFleet = e.target.value || null;
  try { localStorage.setItem("fleet-canvas-fleet", currentFleet || ""); } catch(err) {}
  selected = null;
  document.getElementById("side").classList.remove("open");
  tick();
});

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
