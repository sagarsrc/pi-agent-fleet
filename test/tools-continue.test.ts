import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeFleet } from "../src/controller.js";
import { registerFleetTools } from "../src/tools.js";
import { fakeModel, registryFor } from "./fakes.js";

interface CapturedTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function captureTools(): { tools: Map<string, CapturedTool>; pi: ExtensionAPI } {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (def: CapturedTool) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  return { tools, pi };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function ctx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: registryFor([fakeModel("openai", "gpt-5.4-mini")]),
  } as unknown as ExtensionContext;
}

async function plannedFleetRoot(cwd: string): Promise<string> {
  const { tools, pi } = captureTools();
  registerFleetTools(pi);
  const plan = tools.get("fleet_plan")!;
  const result = await plan.execute("id", {
    fleet: {
      fleet_name: "continue-test",
      type: "dag",
      config: { max_concurrent: 1, model: "gpt-5.4-mini" },
      workers: [
        { id: "a", type: "research", task: "t", depends_on: [], outputs: [{ path: "output/a.md", kind: "markdown", required: true }] },
        { id: "b", type: "research", task: "t", depends_on: ["a"], outputs: [{ path: "output/b.md", kind: "markdown", required: true }] },
      ],
    },
  }, undefined, undefined, ctx(cwd));
  expect(textOf(result)).toContain("fleet root:");
  return activeFleet.current!.fleetRoot;
}

async function loadState(fleetRoot: string) {
  return JSON.parse(await readFile(join(fleetRoot, "state.json"), "utf-8"));
}

async function saveState(fleetRoot: string, state: unknown) {
  await writeFile(join(fleetRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

describe("fleet_continue tool", () => {
  it("refuses fleet_launch on a partially started fleet", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fleet-continue-"));
    await plannedFleetRoot(cwd);
    const fleetRoot = activeFleet.current!.fleetRoot;
    const state = await loadState(fleetRoot);
    state.nodes.a.status = "completed";
    state.nodes.a.produced_outputs = ["output/a.md"];
    await saveState(fleetRoot, state);
    activeFleet.current!.state = state;

    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    const launch = tools.get("fleet_launch")!;
    const result = await launch.execute("id", {}, undefined, undefined, ctx(cwd));
    expect(textOf(result)).toContain("fleet already started");
    expect(textOf(result)).toContain("fleet_continue");
  });

  it("refuses fleet_continue on a not-yet-started fleet", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fleet-continue-"));
    await plannedFleetRoot(cwd);

    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    const cont = tools.get("fleet_continue")!;
    const result = await cont.execute("id", {}, undefined, undefined, ctx(cwd));
    expect(textOf(result)).toContain("fleet has not started");
    expect(textOf(result)).toContain("fleet_launch");
  });

  it("refuses fleet_continue on a paused or completed fleet", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fleet-continue-"));
    await plannedFleetRoot(cwd);
    const fleetRoot = activeFleet.current!.fleetRoot;

    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    const cont = tools.get("fleet_continue")!;

    let state = await loadState(fleetRoot);
    state.status = "paused";
    await saveState(fleetRoot, state);
    let result = await cont.execute("id", {}, undefined, undefined, ctx(cwd));
    expect(textOf(result)).toContain("fleet is paused");

    state = await loadState(fleetRoot);
    state.status = "completed";
    await saveState(fleetRoot, state);
    result = await cont.execute("id", {}, undefined, undefined, ctx(cwd));
    expect(textOf(result)).toContain("fleet completed");
  });

  it("continues a failed fleet from current state and writes fresh prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fleet-continue-"));
    await plannedFleetRoot(cwd);
    const fleetRoot = activeFleet.current!.fleetRoot;

    const state = await loadState(fleetRoot);
    state.status = "failed";
    state.nodes.a.status = "killed";
    state.nodes.b.status = "blocked";
    await saveState(fleetRoot, state);
    await writeFile(join(fleetRoot, "workers", "a", "prompt.md"), "stale prompt", "utf-8");
    await writeFile(join(fleetRoot, "workers", "b", "prompt.md"), "stale prompt", "utf-8");

    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    const cont = tools.get("fleet_continue")!;
    const result = await cont.execute("id", {}, undefined, undefined, ctx(cwd));
    expect(textOf(result)).toContain("fleet continue requested");

    const next = await loadState(fleetRoot);
    expect(next.status).toBe("running");
    const aPrompt = await readFile(join(fleetRoot, "workers", "a", "prompt.md"), "utf-8");
    const bPrompt = await readFile(join(fleetRoot, "workers", "b", "prompt.md"), "utf-8");
    expect(aPrompt).not.toBe("stale prompt");
    expect(bPrompt).not.toBe("stale prompt");
    expect(aPrompt).toContain("Fleet worker: a");
    expect(bPrompt).toContain("Fleet worker: b");
  });
});
