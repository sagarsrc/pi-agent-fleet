# Fleet Canvas v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canvas v2 — infinite canvas (pan/zoom/fit), rich fleet.json-driven node cards, light+dark themes, and re-visualization of any fleet root on disk.

**Architecture:** Enrich `buildCanvasPayload` with full worker/config/iteration data; add `readDiskFleet`/`listFleetRoots` + `?fleet=` routes; rewrite the page around a camera-transformed viewport with layered layout, wires in layout coords, theme variables, and a fleet picker.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, node:http, zero dependencies.

**Worktree root (all paths resolve here):** `/Users/sagar/work/pi-fleet-extension/.worktrees/fleet-canvas-v2`

## Global Constraints

- All local imports use the `.js` suffix (NodeNext ESM).
- `npm test` AND `npm run typecheck` green at the end of every task.
- No new dependencies.
- Commit style: conventional (`feat:`, `fix:`). One commit per task.
- Canvas stays READ-ONLY. Server binds 127.0.0.1 only, port 0 default.
- Page JS must avoid backticks (TS template literal embedding).
- Preserve existing behaviors: paused pill, connection-lost header indicator, `esc()` with quote hardening, scroll preservation, `?node=` deep-link, 1500ms state poll / 2000ms session poll.
- Zoom clamps: `MIN_ZOOM = 0.2`, `MAX_ZOOM = 2.5`.
- Disk fleet name key = `.fleet/` dir basename (e.g. `energy-tech-brief-20260803033629`).

---

### Task 1: Rich payload + disk fleets + API routes

**Files:**
- Modify: `src/canvas.ts`
- Modify: `src/controller.ts` (pass `cwd` to startCanvasServer — needs the ExtensionContext cwd; ensureCanvas signature gains cwd)
- Modify: `src/index.ts`, `src/command.ts`, `src/tools.ts` ONLY for the ensureCanvas call-site updates
- Test: `test/canvas.test.ts`, `test/controller.test.ts`

**Interfaces:**
- Produces:
  - `CanvasNodeView` gains `type: string; task: string; outputs: Array<{ path: string; kind: string; required: boolean }>; depends_on: string[]; iterate: boolean; worktree: boolean`
  - `CanvasPayload` gains `config: { max_concurrent: number; model?: string; effort?: string; warn_cost_usd?: number }` and `iterations: Array<{ n: number; verdict: string | null; cost: number; tokens: number; duration_ms: number }>`
  - `readDiskFleet(fleetRoot: string): Promise<ActiveFleet>` (throws on missing/corrupt files)
  - `listFleetRoots(cwd: string): Promise<Array<{ name: string; root: string; status: string; created_at: string }>>`
  - `startCanvasServer(opts: { getFleet: () => ActiveFleet | undefined; cwd: string; port?: number })`
  - `ensureCanvas(ctx: ExtensionContext): Promise<CanvasServer>` (was zero-arg)
- Consumes: existing `readState` from state.js for disk state parsing.

- [ ] **Step 1: Write the failing tests**

Append to `test/canvas.test.ts`:

```typescript
import { listFleetRoots, readDiskFleet } from "../src/canvas.js";
import { writeState } from "../src/state.js";

describe("enriched payload", () => {
  it("includes worker structure and fleet config", () => {
    const rich: FleetSpec = {
      fleet_name: "rich", type: "dag",
      config: { max_concurrent: 3, model: "m", effort: "high", warn_cost_usd: 5 },
      workers: [
        { id: "a", type: "research", task: "do research", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }], iterate: true, worktree: false },
        { id: "b", type: "code-run", task: "build it", depends_on: ["a"], outputs: [], iterate: false, worktree: true },
      ],
    };
    const f = fleet();
    f.spec = rich;
    const p = buildCanvasPayload(f);
    expect(p.config).toEqual({ max_concurrent: 3, model: "m", effort: "high", warn_cost_usd: 5 });
    const a = p.nodes.find((n) => n.id === "a")!;
    expect(a.type).toBe("research");
    expect(a.task).toBe("do research");
    expect(a.outputs).toEqual([{ path: "output/a.md", kind: "markdown", required: true }]);
    const b = p.nodes.find((n) => n.id === "b")!;
    expect(b.depends_on).toEqual(["a"]);
    expect(b.iterate).toBe(false);
    expect(b.worktree).toBe(true);
  });
});

describe("readDiskFleet + listFleetRoots", () => {
  async function diskRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fleet-disk-"));
    const root = join(dir, ".fleet", "demo-20260101000000");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "fleet.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
    await writeState(root, initFleetState(spec));
    return dir;
  }

  it("reads a fleet root from disk", async () => {
    const dir = await diskRoot();
    const f = await readDiskFleet(join(dir, ".fleet", "demo-20260101000000"));
    expect(f.spec.fleet_name).toBe("t");
    expect(f.state.status).toBe("planned");
    expect(f.fleetRoot).toContain("demo-20260101000000");
    expect(f.running).toBe(false);
  });

  it("throws on missing fleet.json", async () => {
    await expect(readDiskFleet(await mkdtemp(join(tmpdir(), "fleet-disk-")))).rejects.toThrow();
  });

  it("lists fleet roots newest first, skipping non-fleet dirs", async () => {
    const dir = await diskRoot();
    await mkdir(join(dir, ".fleet", "design-x-2026", "planner"), { recursive: true }); // no fleet.json
    const roots = await listFleetRoots(dir);
    expect(roots.length).toBe(1);
    expect(roots[0].name).toBe("demo-20260101000000");
    expect(roots[0].status).toBe("planned");
    expect(typeof roots[0].created_at).toBe("string");
  });

  it("returns [] when .fleet does not exist", async () => {
    expect(await listFleetRoots(await mkdtemp(join(tmpdir(), "fleet-disk-")))).toEqual([]);
  });
});

describe("fleet-aware routes", () => {
  it("serves /api/fleets and ?fleet= disk payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-routes-"));
    const root = join(dir, ".fleet", "old-fleet-20260101000000");
    await mkdir(join(root, "workers", "a"), { recursive: true });
    await writeFile(join(root, "fleet.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
    await writeState(root, initFleetState(spec));
    await writeFile(join(root, "workers", "a", "2026-01-01T00-00-00-000Z_x.jsonl"),
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"old peek"}]}}', "utf-8");

    const server = await startCanvasServer({ getFleet: () => undefined, cwd: dir });
    try {
      const fleets = await (await fetch(`${server.url}/api/fleets`)).json();
      expect(fleets.fleets[0].name).toBe("old-fleet-20260101000000");

      const disk = await (await fetch(`${server.url}/api/state?fleet=old-fleet-20260101000000`)).json();
      expect(disk.fleet_name).toBe("t");

      const sess = await (await fetch(`${server.url}/api/session/a?fleet=old-fleet-20260101000000`)).json();
      expect(sess.entries[0].text).toBe("old peek");

      const missing = await fetch(`${server.url}/api/state?fleet=nope-2026`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("no fleet param falls back to the live fleet", async () => {
    const f = fleet();
    const server = await startCanvasServer({ getFleet: () => f, cwd: "/tmp" });
    try {
      const state = await (await fetch(`${server.url}/api/state`)).json();
      expect(state.fleet_name).toBe("t");
    } finally {
      await server.close();
    }
  });
});
```

In `test/controller.test.ts`, the existing canvas lifecycle tests call `ensureCanvas()` — they must pass a ctx-like object: change calls to `ensureCanvas({ cwd: "/tmp" } as unknown as ExtensionContext)` (ExtensionContext is already imported there).

(`mkdir` may need adding to fs imports in test/canvas.test.ts.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/canvas.test.ts test/controller.test.ts`
Expected: FAIL — `readDiskFleet`/`listFleetRoots` missing; `startCanvasServer` has no `cwd`.

- [ ] **Step 3: Implement**

`src/canvas.ts`:

1. `CanvasNodeView` — add fields:

```typescript
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
```

2. `CanvasPayload` — add fields:

```typescript
  config: { max_concurrent: number; model?: string; effort?: string; warn_cost_usd?: number };
  iterations: Array<{ n: number; verdict: string | null; cost: number; tokens: number; duration_ms: number }>;
```

3. In `buildCanvasPayload`, fill them:

```typescript
    config: {
      max_concurrent: spec.config.max_concurrent,
      model: spec.config.model,
      effort: spec.config.effort,
      warn_cost_usd: spec.config.warn_cost_usd,
    },
    iterations: state.iterations.map((it) => ({
      n: it.n,
      verdict: it.verdict,
      cost: Object.values(it.nodes).reduce((s, n) => s + n.cost_usd_estimate, 0),
      tokens: Object.values(it.nodes).reduce((s, n) => s + n.tokens, 0),
      duration_ms: new Date(it.ended_at).getTime() - new Date(it.started_at).getTime(),
    })),
```

and in the node map add: `type: w.type, task: w.task, outputs: w.outputs.map((o) => ({ path: o.path, kind: o.kind, required: o.required })), depends_on: [...w.depends_on], iterate: w.iterate !== false, worktree: w.worktree === true,`

4. Add disk functions (imports: `readdir`, `stat` from fs/promises; `basename` from path; `readState` from `./state.js`; types `FleetSpec`, `FleetState`):

```typescript
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

export interface FleetRootInfo {
  name: string;
  root: string;
  status: string;
  created_at: string;
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
```

5. `startCanvasServer` — opts gains `cwd: string`; add routes (before the session route):

```typescript
      if (url.pathname === "/api/fleets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ fleets: await listFleetRoots(opts.cwd) }));
        return;
      }
```

Rework `/api/state` and `/api/session/<id>` to resolve the target fleet via a helper:

```typescript
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
```

- `/api/state`: `const f = await resolveFleet(url.searchParams.get("fleet")); if (f === "unknown") 404; else f ? payload : {empty:true}`.
- `/api/session/<id>`: same resolution; `undefined`/`"unknown"` → 404.

6. `src/controller.ts` — `ensureCanvas` gains ctx:

```typescript
export async function ensureCanvas(ctx: ExtensionContext): Promise<CanvasServer> {
  canvas ??= startCanvasServer({ getFleet: () => activeFleet.current, cwd: ctx.cwd });
  return canvas;
}
```

Update call sites: `src/command.ts` (`/fleet canvas` branch: `await ensureCanvas(ctx)`), `src/tools.ts` (`fleet_canvas`: `await ensureCanvas(ctx)` — its execute already receives ctx). `src/index.ts` untouched (stopCanvas only).

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/canvas.ts src/controller.ts src/command.ts src/tools.ts test/canvas.test.ts test/controller.test.ts
git commit -m "feat: rich canvas payload, disk fleet reading, /api/fleets and ?fleet= routes"
```

---

### Task 2: Page v2 — infinite canvas, themes, rich cards, fleet picker + command/tool args

**Files:**
- Modify: `src/canvas.ts` (`renderCanvasPage` full rewrite)
- Modify: `src/command.ts` (`/fleet canvas [name]`)
- Modify: `src/tools.ts` (`fleet_canvas` `fleet` param)
- Test: `test/canvas.test.ts`

**Interfaces:**
- Consumes: Task 1's routes and payload fields.
- Produces: page markers `zoomAt`, `fitView`, `fleetSel`, `MIN_ZOOM`, `MAX_ZOOM`; URL params `?fleet=<name>` + `?node=<id>` both supported.

- [ ] **Step 1: Write the failing tests**

Append to `test/canvas.test.ts`:

```typescript
describe("page v2", () => {
  it("has infinite canvas, themes, fleet picker, rich cards", () => {
    const html = renderCanvasPage();
    expect(html).toContain("zoomAt");
    expect(html).toContain("fitView");
    expect(html).toContain("MIN_ZOOM");
    expect(html).toContain("MAX_ZOOM");
    expect(html).toContain("fleetSel");
    expect(html).toContain("body.light");
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain("out-chip");
    expect(html).toContain('qs.get("fleet")');
    expect(html).toContain('qs.get("node")');
  });

  it("keeps legacy markers", () => {
    const html = renderCanvasPage();
    expect(html).toContain("/api/state");
    expect(html).toContain("/api/fleets");
    expect(html).toContain("/api/session/");
    expect(html).not.toContain("`");
  });
});
```

(The `` ` `` assertion guarantees the no-backtick rule.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/canvas.test.ts`
Expected: FAIL — markers missing.

- [ ] **Step 3: Implement**

Replace the entire `renderCanvasPage` function in `src/canvas.ts` with the v2 page below. Keep everything else in the file unchanged.

```typescript
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
  var t = null;
  try { t = localStorage.getItem("fleet-canvas-theme"); } catch(e) {}
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
function nodePos(n){
  return { x: n._lx, y: n._ly, w: 260, h: n._el ? n._el.offsetHeight : 110 };
}
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
    + '<div class="stats">' + n.turns + ' turns · ' + (n.tokens/1000).toFixed(1) + 'k tok · $' + n.cost_usd_estimate.toFixed(2) + '</div>'
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
    hdr.innerHTML = '<span class="pill">' + esc(s.status) + '</span>'
      + (s.paused ? '<span class="pill">paused</span>' : '')
      + '<span>' + done + '/' + s.nodes.length + ' done</span>'
      + '<span>$' + s.cost_usd_estimate.toFixed(2) + '</span>'
      + '<span class="meta">' + esc(loop) + '</span>';
    var st = stage.scrollTop;
    render(s);
    stage.scrollTop = st;
  }).catch(function(){
    document.getElementById("hdr").innerHTML = '<span class="pill">connection lost</span>';
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
  }).catch(function(){ tick(); });
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
var qs2 = new URLSearchParams(location.search);
var pre = qs2.get("node");
if(pre) sel(pre);
</script>
</body>
</html>`;
}
```

Note: the side panel session route should also return the node's task. In `src/canvas.ts`, in the `/api/session/<id>` handler, add `task` to the JSON: find the worker in the resolved fleet's spec and include `task: worker?.task`. Adjust the response to `res.end(JSON.stringify({ entries: ..., task: worker?.task }))`.

`src/command.ts` — `/fleet canvas` gains optional name arg:

```typescript
if (cmd === "canvas") {
  const sub = args.trim().split(/\s+/)[1];
  if (sub === "stop") {
    await stopCanvas();
    ctx.ui.notify("fleet canvas stopped", "info");
    return;
  }
  const server = await ensureCanvas(ctx);
  let url = server.url;
  if (sub) {
    const roots = await listFleetRoots(ctx.cwd);
    if (!roots.some((r) => r.name === sub)) {
      ctx.ui.notify(`unknown fleet "${sub}" (see /api/fleets on the canvas server)`, "error");
      return;
    }
    url = `${url}?fleet=${encodeURIComponent(sub)}`;
  }
  await openInBrowser(url);
  ctx.ui.notify(`fleet canvas: ${url}`, "info");
  return;
}
```

(import `listFleetRoots` from `./canvas.js`.)

`src/tools.ts` — `fleet_canvas` gains the param and carries it into the URL (also validate via `listFleetRoots(ctx.cwd)`, returning an error textResult for unknown names):

```typescript
parameters: Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("stop"), Type.Literal("url")])),
  fleet: Type.Optional(Type.String({ description: "Fleet root dir basename under .fleet to visualize (e.g. energy-brief-20260803000000); omit for the live fleet" })),
}),
// in execute, after ensureCanvas(ctx):
let url = server.url;
if (params.fleet) {
  const roots = await listFleetRoots(ctx.cwd);
  if (!roots.some((r) => r.name === params.fleet)) return textResult(`unknown fleet "${params.fleet}"`);
  url = `${url}?fleet=${encodeURIComponent(params.fleet)}`;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/canvas.ts src/command.ts src/tools.ts test/canvas.test.ts
git commit -m "feat: canvas v2 - infinite canvas with pan/zoom/fit, light+dark themes, rich cards, fleet picker"
```

---

## Self-Review Notes

- Spec coverage: rich payload + disk fleets → Task 1; infinite canvas/themes/picker/commands → Task 2. ✅
- Placeholder scan: page is complete JS (no backticks); all code present. ✅
- Type consistency: `readDiskFleet` returns full `ActiveFleet` shape (sessions/killedNodes inert); `ensureCanvas(ctx)` signature change ripples to exactly 2 call sites + tests. ✅
- The `/api/session` `task` field addition lives in Task 2 (page consumes `r.task`) — server change included in Task 2's instructions. ✅
