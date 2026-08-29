import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCanvasPayload,
  listFleetRoots,
  openInBrowser,
  parseSessionTail,
  readDiskFleet,
  renderCanvasPage,
  startCanvasServer,
} from "../src/canvas.js";
import type { ActiveFleet } from "../src/controller.js";
import { initFleetState, patchNode, writeState } from "../src/state.js";
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
    running: true, sessions: new Map(), killedNodes: new Set(), relaunchRequests: new Set(),
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
    expect(out.entries).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi\n[tool: bash]" },
      { role: "tool", text: "[tool result]" },
    ]);
    expect(out.actions.map((a) => a.type)).toEqual(["tool_call", "tool_result"]);
    expect(out.events.map((e) => e.type)).toEqual(["message", "tool_call", "message", "tool_result", "message"]);
  });

  it("respects the tail limit", () => {
    expect(parseSessionTail(jsonl, 1).entries).toEqual([{ role: "tool", text: "[tool result]" }]);
  });

  it("caps entry text at 4000 chars", () => {
    const long = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${"x".repeat(5000)}"}]}}`;
    const out = parseSessionTail(long, 5);
    expect(out.entries[0].text.length).toBe(4001); // 4000 + ellipsis
    expect(out.entries[0].text.endsWith("…")).toBe(true);
  });

  it("caps huge tool call arguments so session sidebar payload stays small", () => {
    const jsonl = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "write", arguments: { path: "output/report.md", content: "x".repeat(100_000) } }],
      },
    });
    const out = parseSessionTail(jsonl, 30);
    expect(JSON.stringify(out).length).toBeLessThan(10_000);
    expect(out.actions[0].arguments).toEqual({ path: "output/report.md", content: "[omitted 100000 chars]" });
    expect(out.events[0]).toMatchObject({ type: "tool_call", arguments: { path: "output/report.md", content: "[omitted 100000 chars]" } });
  });
});

describe("renderCanvasPage", () => {
  it("embeds the polling app", async () => {
    const html = await renderCanvasPage();
    expect(html).toContain("/api/state");
    expect(html).toContain("/api/session/");
    // self-contained: React + @xyflow bundle inlined, no external script/style hosts
    expect(html).not.toContain("http://cdn");
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link ");
  });

  it("ships selectable error CSS, nodrag hooks, tucked instructions, dense timeline toggles", async () => {
    const html = await renderCanvasPage();
    expect(html).toContain("user-select:text");
    expect(html).toContain("note nodrag");
    expect(html).toContain("Instructions (task prompt)");
    expect(html).toContain("show more");
    expect(html).toContain("show less");
  });

  it("ships start, end, and gate node treatments", async () => {
    const html = await renderCanvasPage();
    expect(html).toContain("START");
    expect(html).toContain("END");
    expect(html).toContain("GATE");
    expect(html).toContain("role-start");
    expect(html).toContain("role-end");
    expect(html).toContain("role-gate");
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

    const server = await startCanvasServer({ getFleet: () => f, cwd: "/tmp" });
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
    const server = await startCanvasServer({ getFleet: () => undefined, cwd: "/tmp" });
    try {
      const state = await (await fetch(`${server.url}/api/state`)).json();
      expect(state.empty).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("demo endpoint", () => {
  it("serves a demo payload", async () => {
    const server = await startCanvasServer({ getFleet: () => undefined, cwd: "/tmp" });
    try {
      const demo = await (await fetch(`${server.url}/api/demo`)).json();
      // demo is a baked snapshot of a real fleet's structure
      expect(typeof demo.fleet_name).toBe("string");
      expect(demo.fleet_name.length).toBeGreaterThan(0);
      expect(demo.nodes.length).toBeGreaterThan(1);
      expect(demo.demo).toBe(true);
      expect(demo.edges.length).toBeGreaterThan(0);
      expect(demo.generated_at).toBeTruthy();
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

describe("page v3 (@xyflow/react)", () => {
  it("bundles the react-flow canvas with themes, fleet picker, rich cards", async () => {
    const html = await renderCanvasPage();
    // React app mounts into #root
    expect(html).toContain('id="root"');
    expect(html).toContain("createRoot");
    // @xyflow/react bundled + its stylesheet inlined
    expect(html).toContain("react-flow");
    expect(html).toContain(".react-flow__node");
    // theming, fleet picker, rich card styles preserved
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain("data-theme");
    expect(html).toContain("out-chip");
    // deep-links honored by the client
    expect(html).toContain('"fleet"');
    expect(html).toContain('"node"');
  });

  it("keeps api markers and stays self-contained", async () => {
    const html = await renderCanvasPage();
    expect(html).toContain("/api/state");
    expect(html).toContain("/api/fleets");
    expect(html).toContain("/api/session/");
    expect(html).not.toContain("http://cdn");
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
