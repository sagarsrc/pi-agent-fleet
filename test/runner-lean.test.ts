import { describe, expect, it, vi, beforeEach } from "vitest";
import { defaultSessionFactory, sessionFactoryForModel, filterExtensionsByAllowlist } from "../src/runner.js";

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

describe("filterExtensionsByAllowlist", () => {
  const exts: Array<{ path: string }> = [
    { path: "npm:opencode-pi" },
    { path: "npm:pi-web-access" },
    { path: "/Users/x/work/pi-fleet-extension/src/index.ts" },
  ];

  it("keeps only extensions whose path matches the allowlist", () => {
    const out = filterExtensionsByAllowlist(exts, ["opencode-pi"]);
    expect(out.map((e) => e.path)).toEqual(["npm:opencode-pi"]);
  });

  it("returns all extensions when allowlist is empty or undefined", () => {
    expect(filterExtensionsByAllowlist(exts, [])).toHaveLength(3);
    expect(filterExtensionsByAllowlist(exts, undefined)).toHaveLength(3);
  });

  it("matches partial path segments (e.g. local dev paths)", () => {
    const out = filterExtensionsByAllowlist(exts, ["pi-fleet-extension"]);
    expect(out.map((e) => e.path)).toEqual(["/Users/x/work/pi-fleet-extension/src/index.ts"]);
  });
});

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

  it("allowlisted extensions survive the lean loader, others are filtered out", async () => {
    await defaultSessionFactory({
      cwd: "/tmp/lean",
      sessionDir: "/tmp/lean/.sessions",
      tools: ["read"],
      thinkingLevel: "low",
      extensionAllowlist: ["opencode-pi"],
    });
    expect(createAgentSessionCalls).toHaveLength(1);
    const opts = createAgentSessionCalls[0] as { resourceLoader?: { reload: () => Promise<void>; getExtensions: () => { extensions: Array<{ path: string }> } } };
    expect(opts.resourceLoader).toBeDefined();
    await opts.resourceLoader!.reload();
    // /tmp/lean has no real extensions installed; whatever loads, every entry must
    // match the allowlist (pi-web-access, caveman, etc. must be gone).
    for (const e of opts.resourceLoader!.getExtensions().extensions) {
      expect(e.path).toContain("opencode-pi");
    }
  });
});
