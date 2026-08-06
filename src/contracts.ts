import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ContractCheck, ContractOutput, ContractResult, Verdict } from "./types.js";

export const VERDICT_RE = /^verdict:\s*(lgtm|iterate|escalate)\s*$/mi;

function resolvePath(workerDir: string, repoCwd: string, p: string): string {
  if (isAbsolute(p)) return p;
  return p.startsWith("output/") ? join(workerDir, p) : join(repoCwd, p);
}

async function checkOne(workerDir: string, repoCwd: string, o: ContractOutput): Promise<ContractCheck> {
  const full = resolvePath(workerDir, repoCwd, o.path);
  const fail = (error: string): ContractCheck => ({ path: o.path, kind: o.kind, required: o.required, ok: false, error });
  let content: string;
  try {
    const s = await stat(full);
    if (o.kind === "file-exists") {
      return s.size > 0
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("empty file");
    }
    content = await readFile(full, "utf-8");
  } catch {
    return fail("file not found");
  }
  switch (o.kind) {
    case "markdown": {
      const first = content.split("\n").find((l) => l.trim().length > 0) ?? "";
      return first.startsWith("#")
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("no markdown heading");
    }
    case "verdict": {
      const m = content.match(VERDICT_RE);
      if (!m) return fail("no verdict line");
      const body = content.slice(content.indexOf(m[0]) + m[0].length).trim();
      return body.length > 0
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("verdict line without body");
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        return fail(`json parse error: ${(e as Error).message}`);
      }
      if (o.schema) {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("json schema requires an object");
        const obj = parsed as Record<string, unknown>;
        for (const key of o.schema.required_keys ?? []) if (!Object.hasOwn(obj, key)) return fail(`missing required key "${key}"`);
        for (const key of o.schema.number_keys ?? []) {
          const v = obj[key];
          const ok = typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "number"));
          if (!ok) return fail(`key "${key}" must be a number or number[]`);
        }
      }
      return { path: o.path, kind: o.kind, required: o.required, ok: true };
    }
    case "yaml": {
      const bad = content.split("\n").some((l) => l.includes("\t"));
      return content.trim().length > 0 && !bad
        ? { path: o.path, kind: o.kind, required: o.required, ok: true }
        : fail("empty or invalid yaml");
    }
    default:
      return fail(`unknown kind`);
  }
}

export async function verifyOutputs(opts: {
  workerDir: string;
  repoCwd: string;
  outputs: ContractOutput[];
}): Promise<ContractResult> {
  const checks = await Promise.all(opts.outputs.map((o) => checkOne(opts.workerDir, opts.repoCwd, o)));
  const ok = checks.every((c) => !c.required || c.ok);

  const verdictCheck = checks.find((c) => c.kind === "verdict" && c.ok);
  if (!verdictCheck) return { ok, checks };

  const content = await readFile(resolvePath(opts.workerDir, opts.repoCwd, verdictCheck.path), "utf-8");
  const m = content.match(VERDICT_RE);
  if (!m) return { ok, checks };

  const verdict = m[1].toLowerCase() as Verdict;
  const verdict_body = content.slice(content.indexOf(m[0]) + m[0].length).trim();
  return verdict_body.length > 0 ? { ok, checks, verdict, verdict_body } : { ok, checks };
}
