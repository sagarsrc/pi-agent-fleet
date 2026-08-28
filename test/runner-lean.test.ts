import { describe, expect, it, vi, beforeEach } from "vitest";
import { defaultSessionFactory, sessionFactoryForModel } from "../src/runner.js";

const fakeSession = {
  prompt: async () => {},
  abort: async () => {},
  subscribe: () => () => {},
  dispose: () => {},
};

let createAgentSessionCalls: unknown[] = [];

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual("@earendil-works/pi-coding-agent");
  return {
    ...(actual as object),
    createAgentSession: vi.fn(async (options: unknown) => {
      createAgentSessionCalls.push(options);
      return { session: fakeSession, extensionsResult: { extensions: [], diagnostics: [] } };
    }),
  };
});

beforeEach(() => {
  createAgentSessionCalls = [];
});

async function assertEmptyResourceLoader(loader: {
  reload: () => Promise<void>;
  getExtensions: () => { extensions: unknown[] };
  getSkills: () => { skills: unknown[] };
  getPrompts: () => { prompts: unknown[] };
  getThemes: () => { themes: unknown[] };
  getAgentsFiles: () => { agentsFiles: unknown[] };
  getSystemPrompt: () => unknown;
  getAppendSystemPrompt: () => unknown[];
}) {
  await loader.reload();
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
  expect(loader.getThemes().themes).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(loader.getSystemPrompt()).toBeUndefined();
  expect(loader.getAppendSystemPrompt()).toEqual([]);
}

describe("lean worker sessions", () => {
  it("defaultSessionFactory passes an empty resourceLoader", async () => {
    await defaultSessionFactory({
      cwd: "/tmp/lean",
      sessionDir: "/tmp/lean/.sessions",
      tools: ["read"],
      thinkingLevel: "low",
    });
    expect(createAgentSessionCalls).toHaveLength(1);
    const opts = createAgentSessionCalls[0] as { resourceLoader?: unknown };
    expect(opts.resourceLoader).toBeDefined();
    await assertEmptyResourceLoader(opts.resourceLoader as Parameters<typeof assertEmptyResourceLoader>[0]);
  });

  it("sessionFactoryForModel passes an empty resourceLoader", async () => {
    const factory = sessionFactoryForModel({ provider: "test", id: "m" } as any);
    await factory({
      cwd: "/tmp/lean",
      sessionDir: "/tmp/lean/.sessions",
      tools: ["read"],
      thinkingLevel: "low",
    });
    expect(createAgentSessionCalls).toHaveLength(1);
    const opts = createAgentSessionCalls[0] as { resourceLoader?: unknown; model?: unknown };
    expect(opts.model).toEqual({ provider: "test", id: "m" });
    expect(opts.resourceLoader).toBeDefined();
    await assertEmptyResourceLoader(opts.resourceLoader as Parameters<typeof assertEmptyResourceLoader>[0]);
  });
});
