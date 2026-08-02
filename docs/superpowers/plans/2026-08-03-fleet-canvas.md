# Fleet Browser Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local read-only web canvas for the active fleet — live DAG with per-node stats and click-to-peek agent session view (todo.md #5).

**Architecture:** `src/canvas.ts` — dependency-free `node:http` server on `127.0.0.1`, embedded single-page app polling `/api/state` + `/api/session/<id>`; controller singleton; `/fleet canvas` command + `fleet_canvas` tool.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, node:http, pi extension API.

**Worktree root (all paths resolve here):** `/Users/sagar/work/pi-fleet-extension/.worktrees/fleet-canvas`

## Global Constraints

- All local imports use the `.js` suffix (NodeNext ESM).
- `npm test` AND `npm run typecheck` green at the end of every task.
- No new dependencies — server, page, and client JS are hand-rolled.
- Canvas is READ-ONLY: it never mutates fleet state, spec, or files.
- Server binds `127.0.0.1` only; default port `0` (ephemeral).
- The page's client JS must avoid backticks (the HTML is embedded in a TS template literal — no nested backticks).
- `/fleet canvas` works with no active fleet (handled before the `!active` guard).

---

### Task 1: `src/canvas.ts` core (payload, session tail, page, server, browser opener)

**Files:**
- Create: `src/canvas.ts`
- Test: `test/canvas.test.ts`

**Interfaces:**
- Produces:
  - `buildCanvasPayload(fleet: ActiveFleet): CanvasPayload`
  - `parseSessionTail(jsonl: string, maxEntries: number): SessionEntryView[]` (`{ role: string; text: string }`)
  - `renderCanvasPage(): string`
  - `startCanvasServer(opts: { getFleet: () => ActiveFleet | undefined; port?: number; host?: string }): Promise<{ url: string; port: number; close: () => Promise<void> }>`
  - `openInBrowser(url: string, runner?: (cmd: string, args: string[]) => Promise<void>): Promise<void>`
- Consumes: `ActiveFleet` (type-only import from controller).

- [ ] **Step 1: Write the failing tests**

`test/canvas.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCanvasPayload,
  openInBrowser,
  parseSessionTail,
  renderCanvasPage,
  startCanvasServer,
} from "../src/canvas.js";
import type { ActiveFleet } from "../src/controller.js";
import { initFleetState, patchNode } from "../src/state.js";
import type { FleetSpec } from "../src/types.js";

const spec: FleetSpec = {
  fleet_name: "t", type: "dag",
  config: { max_concurrent: 2, model: "k2p6" },
  workers: [
    { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
    { id: "b", type: "write", task: "t", depends_on: ["a"], outputs: [] },
  ],
};

function fleet(): ActiveFleet {
  let state = initFleetState(spec);
  state = patchNode("/x", state, "a", { status: "running", turns: 3, tokens: 1200, cost_usd_estimate: 0.02 });
  return {
    spec, fleetRoot: "/x", state,
    killSwitch: { killed: false }, pauseSwitch: { paused: false },
    running: true, sessions: new Map(), killedNodes: new Set(),
  };
}

describe("buildCanvasPayload", () => {
  it("maps fleet meta, nodes, and edges", () => {
    const p = buildCanvasPayload(fleet());
    expect(p.fleet_name).toBe("t");
    expect(p.status).toBe("planned");
    expect(p.nodes.length).toBe(2);
    const a = p.nodes.find((n) => n.id === "a");
    expect(a?.status).toBe("running");
    expect(a?.turns).toBe(3);
    expect(a?.model).toBe("k2p6");
    expect(p.edges).toEqual([{ from: "a", to: "b" }]);
    expect(typeof p.generated_at).toBe("string");
  });

  it("includes loop config when present", () => {
    const f = fleet();
    f.spec = { ...spec, config: { ...spec.config, loop: { gate: "reviewer", max_iterations: 3, lgtm_count: 2 } } };
    const p = buildCanvasPayload(f);
    expect(p.loop).toEqual({ gate: "reviewer", max_iterations: 3, lgtm_count: 2 });
  });
});

describe("parseSessionTail", () => {
  const jsonl = [
    '{"type":"session","version":3}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"toolCall","name":"bash"}]}}',
    '{bad json',
    '{"type":"message","message":{"role":"tool","content":[{"type":"toolResult"}]}}',
  ].join("\n");

  it("extracts readable entries with tool markers and skips bad lines", () => {
    const out = parseSessionTail(jsonl, 30);
    expect(out).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi\n[tool: bash]" },
      { role: "tool", text: "[tool result]" },
    ]);
  });

  it("respects the tail limit", () => {
    expect(parseSessionTail(jsonl, 1)).toEqual([{ role: "tool", text: "[tool result]" }]);
  });

  it("caps entry text at 4000 chars", () => {
    const long = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${"x".repeat(5000)}"}]}}`;
    const out = parseSessionTail(long, 5);
    expect(out[0].text.length).toBe(4001); // 4000 + ellipsis
    expect(out[0].text.endsWith("…")).toBe(true);
  });
});

describe("renderCanvasPage", () => {
  it("embeds the polling app", () => {
    const html = renderCanvasPage();
    expect(html).toContain("/api/state");
    expect(html).toContain("/api/session/");
    expect(html).not.toContain("http://cdn");
  });
});

describe("startCanvasServer", () => {
  it("serves page, state, session tail, and 404s", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-canvas-"));
    const f = fleet();
    f.fleetRoot = dir;
    await writeFile(join(dir, "a-session.jsonl"), '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"peek"}]}}', "utf-8");
    // latestSessionFile reads *.jsonl in the worker dir
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "workers", "a"), { recursive: true });
    await writeFile(join(dir, "workers", "a", "2026-01-01T00-00-00-000Z_x.jsonl"), '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"peek"}]}}', "utf-8");

    const server = await startCanvasServer({ getFleet: () => f });
    try {
      const page = await fetch(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("/api/state");

      const state = await (await fetch(`${server.url}/api/state`)).json();
      expect(state.fleet_name).toBe("t");

      const sess = await (await fetch(`${server.url}/api/session/a`)).json();
      expect(sess.entries).toEqual([{ role: "user", text: "peek" }]);

      const missing = await fetch(`${server.url}/api/session/zzz`);
      expect(missing.status).toBe(404);

      const nope = await fetch(`${server.url}/nope`);
      expect(nope.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("reports empty when no fleet", async () => {
    const server = await startCanvasServer({ getFleet: () => undefined });
    try {
      const state = await (await fetch(`${server.url}/api/state`)).json();
      expect(state.empty).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("openInBrowser", () => {
  it("maps platforms to opener commands and swallows failures", async () => {
    const calls: string[] = [];
    const runner = async (cmd: string, args: string[]) => { calls.push(`${cmd} ${args[0]}`); };
    await openInBrowser("http://127.0.0.1:1", runner);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("http://127.0.0.1:1");
    await openInBrowser("http://x", async () => { throw new Error("no opener"); }); // must not throw
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/canvas.test.ts`
Expected: FAIL — `Cannot find module '../src/canvas.js'`

- [ ] **Step 3: Implement**

`src/canvas.ts` (complete file). NOTE: the page's client JS deliberately uses string concatenation, never backticks.

```typescript
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
#dag { flex:1; overflow:auto; padding:16px; display:flex; gap:32px; align-items:flex-start; }
.layer { display:flex; flex-direction:column; gap:10px; }
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
function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c]; }); }
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
      + '<span>' + done + '/' + s.nodes.length + ' done</span>'
      + '<span>$' + s.cost_usd_estimate.toFixed(2) + '</span>'
      + '<span class="meta">' + esc(loop) + '</span>';
    var L = layers(s.nodes, s.edges);
    dag.innerHTML = L.map(function(layer){
      return '<div class="layer">' + layer.map(function(id){
        var n = s.nodes.filter(function(x){ return x.id===id; })[0];
        return '<div class="node st-' + esc(n.status) + (selected===n.id?" sel":"") + '" onclick="sel(\\'' + n.id + '\\')">'
          + '<div class="nid">' + esc(n.id) + '</div>'
          + '<div class="meta">' + esc(n.status) + ' · ' + esc(n.model) + (n.effort ? " · " + esc(n.effort) : "") + '</div>'
          + '<div class="meta">' + n.turns + ' turns · ' + (n.tokens/1000).toFixed(1) + 'k tok · $' + n.cost_usd_estimate.toFixed(2) + '</div>'
          + (n.status_note ? '<div class="note">' + esc(n.status_note) + '</div>' : "")
          + '</div>';
      }).join("") + '</div>';
    }).join("");
  }).catch(function(){});
}
function side(){
  if(!selected) return;
  j("/api/session/" + selected + "?tail=30").then(function(r){
    var el = document.getElementById("side");
    el.innerHTML = '<div class="meta"># ' + esc(selected) + ' - recent session</div>'
      + r.entries.map(function(e){
          return '<div class="msg"><div class="role role-' + esc(e.role) + '">' + esc(e.role) + '</div>' + esc(e.text) + '</div>';
        }).join("");
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
  host?: string;
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
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/canvas.ts test/canvas.test.ts
git commit -m "feat: canvas server core - payload, session tail, page, browser opener"
```

---

### Task 2: Wiring — controller singleton, `/fleet canvas`, `fleet_canvas` tool, session lifecycle

**Files:**
- Modify: `src/controller.ts` (`ensureCanvas`/`stopCanvas` singleton)
- Modify: `src/command.ts` (`/fleet canvas [stop]`)
- Modify: `src/tools.ts` (`fleet_canvas` tool)
- Modify: `src/index.ts` (stop canvas on session_start)
- Test: `test/controller.test.ts`

**Interfaces:**
- Produces: `ensureCanvas(): Promise<CanvasServer>`; `stopCanvas(): Promise<void>` (both from controller).
- Consumes: Task 1's `startCanvasServer`, `openInBrowser`, `CanvasServer`.

- [ ] **Step 1: Write the failing tests**

Append to `test/controller.test.ts`:

```typescript
describe("canvas lifecycle", () => {
  it("ensureCanvas returns a singleton and stopCanvas tears it down", async () => {
    const a = await ensureCanvas();
    const b = await ensureCanvas();
    expect(a).toBe(b);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await stopCanvas();
    const c = await ensureCanvas();
    expect(c).not.toBe(a);
    await stopCanvas();
  });

  it("serves the active fleet through the cell", async () => {
    const server = await ensureCanvas();
    activeFleet.current = runningFleet();
    try {
      const state = await (await fetch(`${server.url}/api/state`)).json();
      expect(state.fleet_name).toBe("t");
    } finally {
      activeFleet.current = undefined;
      await stopCanvas();
    }
  });
});
```

(Add `ensureCanvas`, `stopCanvas` to the controller import in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/controller.test.ts`
Expected: FAIL — `ensureCanvas`/`stopCanvas` not exported.

- [ ] **Step 3: Implement**

`src/controller.ts` (imports: `startCanvasServer`, `openInBrowser`, `CanvasServer` from `./canvas.js`):

```typescript
let canvas: CanvasServer | undefined;

export async function ensureCanvas(): Promise<CanvasServer> {
  canvas ??= await startCanvasServer({ getFleet: () => activeFleet.current });
  return canvas;
}

export async function stopCanvas(): Promise<void> {
  if (canvas) {
    await canvas.close();
    canvas = undefined;
  }
}
```

`src/command.ts` — add BEFORE the `if (!active)` guard (canvas works with no fleet; imports: `ensureCanvas`, `stopCanvas` added to the controller import; `openInBrowser` from `./canvas.js`):

```typescript
if (cmd === "canvas") {
  const sub = args.trim().split(/\s+/)[1];
  if (sub === "stop") {
    await stopCanvas();
    ctx.ui.notify("fleet canvas stopped", "info");
    return;
  }
  const server = await ensureCanvas();
  await openInBrowser(server.url);
  ctx.ui.notify(`fleet canvas: ${server.url}`, "info");
  return;
}
```

Update the command description and final usage string to include `/fleet canvas [stop]`.

`src/tools.ts` — register (imports: `ensureCanvas`, `stopCanvas` added to the controller import; `openInBrowser` from `./canvas.js`):

```typescript
pi.registerTool({
  name: "fleet_canvas",
  label: "Fleet Canvas",
  description: "Open a local browser canvas for the active fleet: live DAG with per-node stats and a click-to-peek view of each node's recent agent session. Read-only, binds 127.0.0.1 on an ephemeral port. action 'url' (default) returns the URL without opening a browser; 'open' opens it; 'stop' shuts the server down.",
  promptSnippet: "Open the fleet browser canvas.",
  parameters: Type.Object({
    action: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("stop"), Type.Literal("url")])),
  }),
  async execute(_id, params) {
    const action = params.action ?? "url";
    if (action === "stop") {
      await stopCanvas();
      return textResult("fleet canvas stopped");
    }
    const server = await ensureCanvas();
    if (action === "open") await openInBrowser(server.url);
    return textResult(`fleet canvas: ${server.url}`, { url: server.url });
  },
});
```

`src/index.ts` — in the `session_start` handler, stop the canvas too:

```typescript
pi.on("session_start", (_event, ctx) => {
  activeFleet.current = undefined;
  void stopCanvas();
  ctx.ui.setStatus("fleet", "");
});
```

(add `stopCanvas` to the controller import.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts src/command.ts src/tools.ts src/index.ts test/controller.test.ts
git commit -m "feat: /fleet canvas command and fleet_canvas tool with lifecycle wiring"
```

---

## Self-Review Notes

- Spec coverage: canvas core → Task 1; command/tool/lifecycle → Task 2. ✅
- Placeholder scan: complete code throughout, page JS included. ✅
- Type consistency: `CanvasServer`, `ensureCanvas`/`stopCanvas`, `openInBrowser` used consistently across tasks. ✅
- Task 2 depends on Task 1 exports. Order fixed 1→2.
- Page JS avoids backticks by design (TS template literal embedding); the `\\'` escapes in the onclick attribute are intentional inside the TS template literal.
