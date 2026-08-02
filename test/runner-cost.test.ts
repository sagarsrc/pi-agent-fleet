import { describe, expect, it } from "vitest";
import { runWorker } from "../src/runner.js";
import type { WorkerEvent } from "../src/runner.js";
import type { WorkerSpec } from "../src/types.js";

const worker: WorkerSpec = { id: "w", type: "code-run", task: "t", depends_on: [], outputs: [] };

function fakeSessionWithCost(behavior: "ok" | "throw", cost?: number) {
  const listeners: ((e: { type: string; message?: unknown }) => void)[] = [];
  return {
    async prompt() {
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 100, cost: cost === undefined ? undefined : { total: cost } } } });
      if (behavior === "throw") throw new Error("boom");
    },
    async abort() {},
    subscribe(l: (e: { type: string; message?: unknown }) => void) { listeners.push(l); return () => {}; },
    dispose() {},
  };
}

describe("runWorker cost", () => {
  it("accumulates usage.cost.total into result.cost and emits cost events", async () => {
    const events: WorkerEvent[] = [];
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: (e) => events.push(e),
      sessionFactory: async () => fakeSessionWithCost("ok", 0.02),
    });
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(0.02);
    expect(events.filter((e) => e.type === "cost").map((e) => (e as { cost: number }).cost)).toContain(0.02);
  });

  it("defaults cost to 0 when assistant message has no usage.cost", async () => {
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: () => {},
      sessionFactory: async () => fakeSessionWithCost("ok"),
    });
    expect(r.cost).toBe(0);
  });

  it("returns accumulated cost on error path", async () => {
    const r = await runWorker({
      nodeId: "w", worker, prompt: "p", repoCwd: "/tmp",
      onEvent: () => {},
      sessionFactory: async () => fakeSessionWithCost("throw", 0.015),
    });
    expect(r.ok).toBe(false);
    expect(r.cost).toBe(0.015);
  });
});
