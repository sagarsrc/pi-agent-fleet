import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRetryableError, runFleet } from "../src/scheduler.js";
import type { FleetSpec } from "../src/types.js";

function singleWorkerSpec(): FleetSpec {
  return {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 2, model: "k2p6" },
    workers: [
      { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [] },
    ],
  };
}

function spec(): FleetSpec {
  return {
    fleet_name: "t", type: "dag",
    config: { max_concurrent: 2, model: "k2p6" },
    workers: [
      { id: "a", type: "code-run", task: "t", depends_on: [], outputs: [] },
      { id: "b", type: "code-run", task: "t", depends_on: [], outputs: [] },
      { id: "c", type: "code-run", task: "t", depends_on: [], outputs: [] },
    ],
  };
}

async function root() {
  const r = await mkdtemp(join(tmpdir(), "fleet-retry-"));
  for (const id of ["a", "b", "c"]) {
    await mkdir(join(r, "workers", id, "output"), { recursive: true });
  }
  return r;
}

describe("isRetryableError", () => {
  it("matches retryable provider errors case-insensitively", () => {
    expect(isRetryableError("usage limit has been reached")).toBe(true);
    expect(isRetryableError("Rate Limit Exceeded")).toBe(true);
    expect(isRetryableError("HTTP 429")).toBe(true);
    expect(isRetryableError("provider overloaded")).toBe(true);
    expect(isRetryableError("502 Bad Gateway")).toBe(true);
    expect(isRetryableError("503 Service Unavailable")).toBe(true);
    expect(isRetryableError("request timed out")).toBe(true);
    expect(isRetryableError("ECONNRESET")).toBe(true);
    expect(isRetryableError("ETIMEDOUT")).toBe(true);
    expect(isRetryableError("ECONNREFUSED")).toBe(true);
    expect(isRetryableError("fetch failed")).toBe(true);
    expect(isRetryableError("a random logic error")).toBe(false);
  });
});

describe("runFleet retry", () => {
  it("retries a retryable error once and accumulates turns on success", async () => {
    let calls = 0;
    const s = await runFleet({
      spec: singleWorkerSpec(),
      fleetRoot: await root(),
      repoCwd: "/tmp",
      retryDelayMs: () => 0,
      spawn: async () => {
        calls++;
        if (calls === 1) return { ok: false, turns: 1, tokens: 5, cost: 0.001, error: "usage limit has been reached" };
        return { ok: true, turns: 2, tokens: 10, cost: 0.002 };
      },
    });
    expect(s.nodes.a.status).toBe("completed");
    expect(s.nodes.a.turns).toBe(3);
    expect(s.nodes.a.tokens).toBe(15);
    expect(s.nodes.a.cost_usd_estimate).toBeCloseTo(0.003, 5);
    expect(calls).toBe(2);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    const s = await runFleet({
      spec: singleWorkerSpec(),
      fleetRoot: await root(),
      repoCwd: "/tmp",
      retryDelayMs: () => 0,
      spawn: async () => {
        calls++;
        return { ok: false, turns: 1, tokens: 5, cost: 0.001, error: "syntax error in generated code" };
      },
    });
    expect(s.nodes.a.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("gives up after three total attempts for persistent retryable errors", async () => {
    let calls = 0;
    const s = await runFleet({
      spec: singleWorkerSpec(),
      fleetRoot: await root(),
      repoCwd: "/tmp",
      retryDelayMs: () => 0,
      spawn: async () => {
        calls++;
        return { ok: false, turns: 1, tokens: 3, cost: 0.001, error: "overloaded" };
      },
    });
    expect(s.nodes.a.status).toBe("failed");
    expect(calls).toBe(3);
    expect(s.nodes.a.turns).toBe(3);
    expect(s.nodes.a.tokens).toBe(9);
    expect(s.nodes.a.status_note).toContain("overloaded");
  });
});

describe("runFleet circuit breaker", () => {
  it("blocks remaining nodes after two distinct nodes fail with identical error", async () => {
    const sp = spec();
    sp.config.max_concurrent = 1;
    let calls = 0;
    const s = await runFleet({
      spec: sp,
      fleetRoot: await root(),
      repoCwd: "/tmp",
      retryDelayMs: () => 0,
      spawn: async (id) => {
        calls++;
        return { ok: false, turns: 1, tokens: 5, cost: 0, error: "deliberate non-retryable failure" };
      },
    });
    expect(s.nodes.a.status).toBe("failed");
    expect(s.nodes.b.status).toBe("failed");
    expect(s.nodes.c.status).toBe("blocked");
    expect(s.nodes.c.status_note).toContain("circuit breaker");
    expect(s.nodes.c.status_note).toContain("deliberate non-retryable failure".slice(0, 80));
    expect(s.status).toBe("failed");
    // a and b each failed once; c never spawned
    expect(calls).toBe(2);
  });
});
