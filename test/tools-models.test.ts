import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFleetTools } from "../src/tools.js";
import { fakeModel, registryFor } from "./fakes.js";

interface CapturedTool {
  name: string;
  description?: string;
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

function ctxWithModels(): ExtensionContext {
  const registry = registryFor([
    fakeModel("kimi-coding", "kimi-for-coding"),
    fakeModel("kimi-coding", "k3"),
    fakeModel("openai", "gpt-5.4-mini"),
  ]);
  return {
    cwd: "/tmp/fleet-tools-models-test",
    hasUI: false,
    modelRegistry: registry,
  } as unknown as ExtensionContext;
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("fleet_models tool", () => {
  it("lists available canonical model refs", async () => {
    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    const tool = tools.get("fleet_models");
    expect(tool).toBeDefined();
    const result = await tool!.execute("id", {}, undefined, undefined, ctxWithModels());
    const text = textOf(result);
    expect(text).toContain("available models:");
    expect(text).toContain("kimi-coding/kimi-for-coding");
    expect(text).toContain("openai/gpt-5.4-mini");
  });
});

describe("fleet_plan invalid models", () => {
  it("reports available models and canonical refs for unknown models", async () => {
    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    const tool = tools.get("fleet_plan");
    expect(tool).toBeDefined();
    const fleet = {
      fleet_name: "t",
      type: "dag",
      config: { max_concurrent: 1 },
      workers: [
        { id: "a", type: "research", task: "t", model: "kimi-for-coding/k2.7" },
      ],
    };
    const result = await tool!.execute("id", { fleet }, undefined, undefined, ctxWithModels());
    const text = textOf(result);
    expect(text).toContain("Invalid fleet:");
    expect(text).toContain("available models:");
    expect(text).toContain("kimi-coding/kimi-for-coding");
  });

  it("fleet_plan description points to fleet_models", () => {
    const { tools, pi } = captureTools();
    registerFleetTools(pi);
    expect(tools.get("fleet_plan")!.description).toContain("fleet_models");
  });
});
