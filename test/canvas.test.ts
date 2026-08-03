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

describe("page edges and deep-link", () => {
  it("draws dependency edges and supports ?node= deep-link", () => {
    const html = renderCanvasPage();
    expect(html).toContain("drawEdges");
    expect(html).toContain("data-id");
    expect(html).toContain("wires");
    expect(html).toContain('qs.get("node")');
  });
});
