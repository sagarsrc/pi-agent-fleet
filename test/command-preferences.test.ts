import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fakeModel, registryFor } from "./fakes.js";

const h = vi.hoisted(() => ({ writes: [] as Array<{ path: string; content: string }> }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (path: unknown, content: unknown): Promise<void> => {
      h.writes.push({ path: String(path), content: String(content) });
    },
  };
});

import { registerFleetCommand } from "../src/command.js";

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;

function captureCommand(): { handler: Handler } {
  let handler: Handler | undefined;
  const pi = {
    registerCommand: (_name: string, def: { handler: Handler }) => {
      handler = def.handler;
    },
  } as unknown as ExtensionAPI;
  registerFleetCommand(pi);
  if (!handler) throw new Error("fleet command not registered");
  return { handler };
}

interface Notify {
  message: string;
  level?: string;
}

function ctxWithRegistry(): { ctx: ExtensionContext; notes: Notify[] } {
  const notes: Notify[] = [];
  const registry = registryFor([
    fakeModel("kimi-coding", "kimi-for-coding"),
    fakeModel("openai", "gpt-5.4-mini"),
  ]);
  const ctx = {
    cwd: "/tmp/fleet-command-preferences-test",
    hasUI: true,
    modelRegistry: registry,
    ui: {
      notify: (message: string, level?: string) => {
        notes.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notes };
}

beforeEach(() => {
  h.writes.length = 0;
});

describe("/fleet configure set model", () => {
  it("rejects unknown model with registry suggestions", async () => {
    const { handler } = captureCommand();
    const { ctx, notes } = ctxWithRegistry();
    await handler("configure set model kimi-for-coding/k2.7", ctx);
    const err = notes.find((n) => n.level === "error");
    expect(err).toBeDefined();
    expect(err!.message).toContain("kimi-coding/kimi-for-coding");
    expect(notes.some((n) => n.message === "preference model saved")).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it("stores canonical model preference", async () => {
    const { handler } = captureCommand();
    const { ctx, notes } = ctxWithRegistry();
    await handler("configure set model kimi-for-coding", ctx);
    expect(notes.some((n) => n.message === "preference model saved")).toBe(true);
    expect(h.writes).toHaveLength(1);
    const saved = JSON.parse(h.writes[0].content) as { model?: string };
    expect(saved.model).toBe("kimi-coding/kimi-for-coding");
  });
});
