import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ContractCheck, ContractOutput, ContractResult, Verdict } from "./types.js";

export const VERDICT_RE = /^verdict:\s*(lgtm|iterate|escalate)\s*$/mi;

// Leading metadata lines that a markdown file may place before its first heading.
const MARKDOWN_METADATA_RE = /^(status|verdict):\s*(approved|needs-revision|escalate|lgtm|iterate)\s*$/i;

function resolvePath(workerDir: string, repoCwd: string, p: string): string {
  if (isAbsolute(p)) return p;
  return p.startsWith("output/") ? join(workerDir, p) : join(repoCwd, p);
}

function firstLines(content: string, n = 5): string {
  return content
    .split("\n")
    .slice(0, n)
    .map((l) => l.trimEnd())
    .join(" / ");
}

async function checkOne(workerDir: string, repoCwd: string, o: ContractOutput, notBeforeMs?: number): Promise<ContractCheck> {
  const full = resolvePath(workerDir, repoCwd, o.path);
  const base: Omit<ContractCheck, "ok" | "error"> = { path: o.path, kind: o.kind, required: o.required, actualPath: full };
  const fail = (error: string): ContractCheck => ({ ...base, ok: false, error });
  let content: string;
  try {
    const s = await stat(full);
    if (o.kind === "file-exists") {
      if (s.size === 0) return fail("empty file");
      const repoRelative = !isAbsolute(o.path) && !o.path.startsWith("output/");
      if (repoRelative && notBeforeMs !== undefined && s.mtimeMs < notBeforeMs) {
        return fail("pre-existing repo file not modified since worker start");
      }
      return { ...base, ok: true };
    }
    content = await readFile(full, "utf-8");
  } catch {
    return { path: o.path, kind: o.kind, required: o.required, ok: false, error: "file not found" };
  }

  switch (o.kind) {
    case "markdown": {
      const meaningful = content.split("\n").filter((l) => l.trim().length > 0);
      const first10 = meaningful.slice(0, 10);
      const heading = first10.find((l) => l.trim().startsWith("#"));
      if (heading) {
        return { ...base, ok: true };
      }
      // Check whether the only blocker was a leading metadata line like Status: ...
      const metadataFirst = first10[0]?.match(MARKDOWN_METADATA_RE);
      return { ...fail(metadataFirst ? "no markdown heading after leading metadata line" : "no markdown heading"), firstLines: firstLines(content) };
    }
    case "verdict": {
      const m = content.match(VERDICT_RE);
      if (!m) return { ...base, ok: false, error: "no verdict line", firstLines: firstLines(content) };
      const body = content.slice(content.indexOf(m[0]) + m[0].length).trim();
      return body.length > 0
        ? { ...base, ok: true }
        : { ...base, ok: false, error: "verdict line without body", firstLines: firstLines(content) };
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        return { ...base, ok: false, error: `json parse error: ${(e as Error).message}`, firstLines: firstLines(content) };
      }
      if (o.schema) {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { ...base, ok: false, error: "json schema requires an object", firstLines: firstLines(content) };
        }
        const obj = parsed as Record<string, unknown>;
        for (const key of o.schema.required_keys ?? []) {
          if (!Object.hasOwn(obj, key)) {
            return { ...base, ok: false, error: `missing required key "${key}"`, firstLines: firstLines(content) };
          }
        }
        for (const key of o.schema.number_keys ?? []) {
          const v = obj[key];
          const ok = typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "number"));
          if (!ok) {
            return { ...base, ok: false, error: `key "${key}" must be a number or number[]`, firstLines: firstLines(content) };
          }
        }
      }
      return { ...base, ok: true };
    }
    case "yaml": {
      const bad = content.split("\n").some((l) => l.includes("\t"));
      return content.trim().length > 0 && !bad
        ? { ...base, ok: true }
        : { ...base, ok: false, error: "empty or invalid yaml" };
    }
    default:
      return fail(`unknown kind`);
  }
}

export async function verifyOutputs(opts: {
  workerDir: string;
  repoCwd: string;
  outputs: ContractOutput[];
  notBeforeMs?: number;
}): Promise<ContractResult> {
  const checks = await Promise.all(opts.outputs.map((o) => checkOne(opts.workerDir, opts.repoCwd, o, opts.notBeforeMs)));
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

/** Format a concise, actionable note for the first failed required contract. */
export function contractFailureNote(checks: ContractCheck[]): string {
  const failed = checks.find((c) => c.required && !c.ok);
  if (!failed) return "contract failed";
  const parts = [
    `${failed.path}: ${failed.error}`,
    `actual: ${failed.actualPath ?? "(not found)"}`,
  ];
  if (failed.firstLines) {
    parts.push(`first lines: ${failed.firstLines}`);
  }
  return parts.join("; ");
}
