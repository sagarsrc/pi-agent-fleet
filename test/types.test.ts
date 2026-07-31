import { describe, expect, it } from "vitest";
import { TERMINAL_NODE_STATUSES, WORKER_TYPE_TOOLS } from "../src/types.js";

describe("types", () => {
  it("terminal statuses match ontology", () => {
    expect([...TERMINAL_NODE_STATUSES].sort()).toEqual(
      ["blocked", "completed", "contract_failed", "failed", "killed"],
    );
  });
  it("every worker type has a tool allowlist", () => {
    for (const t of ["research", "code-run", "reviewer", "write", "read-only"] as const) {
      expect(WORKER_TYPE_TOOLS[t].length).toBeGreaterThan(0);
    }
    expect(WORKER_TYPE_TOOLS["read-only"]).not.toContain("write");
    expect(WORKER_TYPE_TOOLS.research).toContain("web_search");
  });
});
