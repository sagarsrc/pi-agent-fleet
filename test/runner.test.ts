import { describe, expect, it } from "vitest";
import { runWorker } from "../src/runner.js";
import type { WorkerSpec } from "../src/types.js";

const worker: WorkerSpec = { id: "w", type: "code-run", task: "t", depends_on: [], outputs: [] };

function fakeSession(behavior: "ok" | "throw") {
  const listeners: ((e: { type: string }) => void)[] = [];
  return {
    async prompt() {
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 100 } } } as { type: string });
      if (behavior === "throw") throw new Error("boom");
    },
    async abort() {},
    subscribe(l: (e: { type: string }) => void) { listeners.push(l); return () => {}; },
    dispose() {},
  };
}

describe("runWorker", () => {
  it("counts turns and tokens, reports done", async () => {
    const events: string[] = [];
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: (e) => events.push(e.type),
      sessionFactory: async () => fakeSession("ok"),
    });
    expect(r.ok).toBe(true);
    expect(r.turns).toBe(1);
    expect(r.tokens).toBe(100);
    expect(events).toContain("done");
  });
  it("returns ok:false on session error", async () => {
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: () => {},
      sessionFactory: async () => fakeSession("throw"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });
  it("forwards thinkingLevel to the session factory", async () => {
    let seen: string | undefined;
    await runWorker({
      nodeId: "a",
      worker: { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
      prompt: "p",
      repoCwd: "/tmp",
      thinkingLevel: "high",
      sessionFactory: async (opts) => {
        seen = opts.thinkingLevel;
        return {
          prompt: async () => {},
          abort: async () => {},
          subscribe: () => () => {},
          dispose: () => {},
        };
      },
      onEvent: () => {},
    });
    expect(seen).toBe("high");
  });

  it("session factory throw becomes a per-node failure", async () => {
    const res = await runWorker({
      nodeId: "a",
      worker: { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
      prompt: "p",
      repoCwd: "/tmp",
      sessionFactory: async () => {
        throw new Error("model exploded");
      },
      onEvent: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("model exploded");
  });
});
