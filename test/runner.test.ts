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

  it("returns ok:false when the final assistant message has stopReason error (model error resolves prompt normally)", async () => {
    function erroredSession() {
      const listeners: ((e: { type: string; message?: unknown }) => void)[] = [];
      return {
        async prompt() {
          for (const l of listeners) l({ type: "turn_end" });
          // pi resolves session.prompt() normally on model errors; the failure is only
          // visible via the assistant message stopReason/errorMessage.
          for (const l of listeners) l({
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" },
          });
        },
        async abort() {},
        subscribe(l: (e: { type: string; message?: unknown }) => void) { listeners.push(l); return () => {}; },
        dispose() {},
      };
    }
    const events: string[] = [];
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: (e) => events.push(e.type),
      sessionFactory: async () => erroredSession(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage limit");
    expect(events).toContain("error");
    expect(events).not.toContain("done");
  });

  it("succeeds when an earlier errored assistant message is followed by a successful one (retry recovery)", async () => {
    function recoveredSession() {
      const listeners: ((e: { type: string; message?: unknown }) => void)[] = [];
      return {
        async prompt() {
          for (const l of listeners) l({
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "transient" },
          });
          for (const l of listeners) l({
            type: "message_end",
            message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 50 } },
          });
        },
        async abort() {},
        subscribe(l: (e: { type: string; message?: unknown }) => void) { listeners.push(l); return () => {}; },
        dispose() {},
      };
    }
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: () => {},
      sessionFactory: async () => recoveredSession(),
    });
    expect(r.ok).toBe(true);
  });

  it("invokes onSession with the created session", async () => {
    const fake = {
      prompt: async () => {},
      abort: async () => {},
      subscribe: () => () => {},
      dispose: () => {},
    };
    let seen: unknown;
    await runWorker({
      nodeId: "a",
      worker: { id: "a", type: "research", task: "t", depends_on: [], outputs: [] },
      prompt: "p",
      repoCwd: "/tmp",
      sessionFactory: async () => fake,
      onSession: (s) => { seen = s; },
      onEvent: () => {},
    });
    expect(seen).toBe(fake);
  });
});
