import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActiveFleet } from "./controller.js";

const execFileP = promisify(execFile);

export interface CanvasNodeView {
  id: string;
  type: string;
  status: string;
  model: string;
  effort?: string;
  turns: number;
  tokens: number;
  cost_usd_estimate: number;
  status_note?: string;
  produced_outputs: string[];
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
  nodes: CanvasNodeView[];
  edges: Array<{ from: string; to: string }>;
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
    nodes: spec.workers.map((w) => {
      const n = state.nodes[w.id];
      return {
        id: w.id,
        type: w.type,
        status: n?.status ?? "pending",
        model: w.model ?? spec.config.model ?? "(default)",
        effort: w.effort ?? spec.config.effort,
        turns: n?.turns ?? 0,
        tokens: n?.tokens ?? 0,
        cost_usd_estimate: n?.cost_usd_estimate ?? 0,
        status_note: n?.status_note,
        produced_outputs: n?.produced_outputs ?? [],
      };
    }),
    edges: spec.workers.flatMap((w) => w.depends_on.map((d) => ({ from: d, to: w.id }))),
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
body { margin:0; font:13px/1.45 -apple-system, Menlo, monospace; background:#0d1117; color:#c9d1d9; }
header { padding:10px 16px; border-bottom:1px solid #21262d; display:flex; gap:14px; align-items:baseline; flex-wrap:wrap; }
header .name { font-weight:700; color:#f0f6fc; }
.pill { padding:1px 8px; border-radius:10px; border:1px solid #30363d; }
main { display:flex; height:calc(100vh - 45px); }
#dag { flex:1; overflow:auto; padding:16px; display:flex; gap:32px; align-items:flex-start; position:relative; }
.layer { display:flex; flex-direction:column; gap:10px; position:relative; z-index:1; }
.node { border:1px solid #30363d; border-radius:8px; padding:8px 10px; min-width:220px; cursor:pointer; background:#161b22; }
.node:hover { border-color:#58a6ff; }
.node.sel { border-color:#58a6ff; box-shadow:0 0 0 1px #58a6ff; }
.node .nid { font-weight:600; }
.meta { color:#8b949e; font-size:12px; }
.note { color:#d29922; font-size:12px; margin-top:4px; }
.st-completed { border-left:4px solid #3fb950; }
.st-running { border-left:4px solid #58a6ff; }
.st-failed, .st-contract_failed { border-left:4px solid #f85149; }
.st-killed, .st-blocked { border-left:4px solid #8b949e; }
.st-pending, .st-ready { border-left:4px solid #30363d; }
#side { width:420px; border-left:1px solid #21262d; overflow:auto; padding:12px; display:none; }
#side.open { display:block; }
.msg { margin-bottom:10px; padding:8px; border-radius:6px; background:#161b22; white-space:pre-wrap; word-break:break-word; }
.msg .role { font-weight:700; margin-bottom:4px; }
.role-user { color:#79c0ff; } .role-assistant { color:#56d364; } .role-tool { color:#d29922; }
#empty { padding:40px; color:#8b949e; }
</style>
</head>
<body>
<header id="hdr">fleet canvas</header>
<main>
<div id="dag"></div>
<div id="side"></div>
</main>
<script>
var selected = null;
function j(u){ return fetch(u).then(function(r){ return r.json(); }); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]; }); }
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
function drawEdges(s){
  var dag = document.getElementById("dag");
  var old = document.getElementById("wires");
  if(old) old.parentNode.removeChild(old);
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "wires");
  svg.setAttribute("width", dag.scrollWidth);
  svg.setAttribute("height", dag.scrollHeight);
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "0";
  s.edges.forEach(function(e){
    var a = dag.querySelector('[data-id="' + e.from + '"]');
    var b = dag.querySelector('[data-id="' + e.to + '"]');
    if(!a || !b) return;
    var x1 = a.offsetLeft + a.offsetWidth;
    var y1 = a.offsetTop + a.offsetHeight/2;
    var x2 = b.offsetLeft;
    var y2 = b.offsetTop + b.offsetHeight/2;
    var mx = (x1 + x2) / 2;
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "#6e7681");
    p.setAttribute("stroke-width", "2");
    svg.appendChild(p);
    var ah = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ah.setAttribute("d", "M " + (x2-6) + " " + (y2-4) + " L " + x2 + " " + y2 + " L " + (x2-6) + " " + (y2+4));
    ah.setAttribute("fill", "none");
    ah.setAttribute("stroke", "#6e7681");
    ah.setAttribute("stroke-width", "2");
    svg.appendChild(ah);
  });
  dag.appendChild(svg);
}
function tick(){
  j("/api/state").then(function(s){
    var hdr = document.getElementById("hdr");
    var dag = document.getElementById("dag");
    if(s.empty){
      hdr.textContent = "fleet canvas - no fleet";
      dag.innerHTML = '<div id="empty">No active fleet. Plan one with fleet_plan.</div>';
      return;
    }
    var loop = s.loop ? " · iter " + s.iteration + "/" + s.loop.max_iterations + " · streak " + s.lgtm_streak : "";
    var done = s.nodes.filter(function(n){ return n.status==="completed"; }).length;
    hdr.innerHTML = '<span class="name">● ' + esc(s.fleet_name) + '</span>'
      + '<span class="pill">' + esc(s.status) + '</span>'
      + (s.paused ? '<span class="pill">paused</span>' : '')
      + '<span>' + done + '/' + s.nodes.length + ' done</span>'
      + '<span>$' + s.cost_usd_estimate.toFixed(2) + '</span>'
      + '<span class="meta">' + esc(loop) + '</span>';
    var L = layers(s.nodes, s.edges);
    var st = dag.scrollTop;
    dag.innerHTML = L.map(function(layer){
      return '<div class="layer">' + layer.map(function(id){
        var n = s.nodes.filter(function(x){ return x.id===id; })[0];
        return '<div class="node st-' + esc(n.status) + (selected===n.id?" sel":"") + '" data-id="' + n.id + '" onclick="sel(\\'' + n.id + '\\')">'
          + '<div class="nid">' + esc(n.id) + '</div>'
          + '<div class="meta">' + esc(n.status) + ' · ' + esc(n.model) + (n.effort ? " · " + esc(n.effort) : "") + '</div>'
          + '<div class="meta">' + n.turns + ' turns · ' + (n.tokens/1000).toFixed(1) + 'k tok · $' + n.cost_usd_estimate.toFixed(2) + '</div>'
          + (n.status_note ? '<div class="note">' + esc(n.status_note) + '</div>' : "")
          + '</div>';
      }).join("") + '</div>';
    }).join("");
    dag.scrollTop = st;
    drawEdges(s);
  }).catch(function(){ var hdr = document.getElementById("hdr"); hdr.innerHTML = '<span class="pill">connection lost</span>'; });
}
function side(){
  if(!selected) return;
  j("/api/session/" + selected + "?tail=30").then(function(r){
    var el = document.getElementById("side");
    var sst = el.scrollTop;
    el.innerHTML = '<div class="meta"># ' + esc(selected) + ' - recent session</div>'
      + r.entries.map(function(e){
          return '<div class="msg"><div class="role role-' + esc(e.role) + '">' + esc(e.role) + '</div>' + esc(e.text) + '</div>';
        }).join("");
    el.scrollTop = sst;
  }).catch(function(){});
}
function sel(id){
  selected = id;
  document.getElementById("side").classList.add("open");
  side();
}
setInterval(tick, 1500);
setInterval(side, 2000);
tick();
var qs = new URLSearchParams(location.search);
var pre = qs.get("node");
if(pre) sel(pre);
</script>
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
      if (url.pathname === "/api/state") {
        const fleet = opts.getFleet();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fleet ? buildCanvasPayload(fleet) : { empty: true }));
        return;
      }
      const m = url.pathname.match(/^\/api\/session\/([a-z0-9][a-z0-9-]*)$/);
      if (m) {
        const fleet = opts.getFleet();
        if (!fleet || !fleet.spec.workers.some((w) => w.id === m[1])) {
          res.writeHead(404);
          res.end();
          return;
        }
        const rawTail = Number(url.searchParams.get("tail"));
        const tail = Number.isInteger(rawTail) && rawTail > 0 ? Math.min(rawTail, 200) : 30;
        const file = await latestSessionFile(join(fleet.fleetRoot, "workers", m[1]));
        res.writeHead(200, { "content-type": "application/json" });
        if (!file) {
          res.end(JSON.stringify({ entries: [] }));
          return;
        }
        const content = await readFile(file, "utf-8");
        res.end(JSON.stringify({ entries: parseSessionTail(content, tail) }));
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
