/**
 * Behavioural lock for the CANONICAL signal-detect heuristic.
 *
 * Replays every vector in `src/signal-detect.vectors.json` through THIS repo's
 * detectFixSignal / suggestSeverity. Any behavioural change to the heuristic turns
 * this red until the fixture is regenerated (`npm run gen:vectors`) — and
 * regenerating changes the artifact's bytes, which is the signal that
 * suraya-brain's hand-mirror (src/lib/severity-derive.ts) must be re-vendored.
 *
 * Read alongside `scripts/gen-signal-detect-vectors.mjs`, which documents why the
 * fixture is behaviour-derived rather than source-hash-derived.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectFixSignal, suggestSeverity, PROMPT_THRESHOLD } from "./signal-detect.js";

type DetectVector = {
  text: unknown;
  expect: { detected: boolean; signal: string; confidence: number; matched_pattern?: string };
};
type SeverityVector = {
  detection: { detected: boolean; signal: string; confidence: number };
  affected_production: boolean;
  expect: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(here, "signal-detect.vectors.json");
const IMPL_PATH = join(here, "signal-detect.ts");

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {
  version: number;
  prompt_threshold: number;
  detect: DetectVector[];
  severity: SeverityVector[];
};

/** JSON has no `undefined` — the generator encodes it; decode to replay the SAME input. */
function decode(v: unknown): unknown {
  return v && typeof v === "object" && (v as { __undefined__?: boolean }).__undefined__ === true
    ? undefined
    : v;
}

describe("signal-detect golden vectors (canonical side)", () => {
  it("the fixture is non-trivially populated", () => {
    // Guards against the vacuous pass: an empty or truncated fixture would make
    // every replay below succeed by iterating nothing.
    expect(vectors.version).toBe(1);
    expect(vectors.detect.length).toBeGreaterThanOrEqual(60);
    expect(vectors.severity.length).toBeGreaterThanOrEqual(400);
    expect(vectors.prompt_threshold).toBe(PROMPT_THRESHOLD);
  });

  it("every PATTERNS label is exercised by at least one detect vector", () => {
    // The same contract the generator refuses to emit without, asserted in the Test
    // job so adding a pattern without a probe cannot land even if nobody regenerates.
    const implSrc = readFileSync(IMPL_PATH, "utf8");
    const labels = [...implSrc.matchAll(/label:\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((l): l is string => typeof l === "string");
    expect(labels.length).toBeGreaterThan(0);
    const matched = new Set(
      vectors.detect.map((v) => v.expect.matched_pattern).filter(Boolean) as string[]
    );
    expect(labels.filter((l) => !matched.has(l))).toEqual([]);
  });

  it("detectFixSignal matches every vector", () => {
    const mismatches: unknown[] = [];
    for (const v of vectors.detect) {
      const actual = detectFixSignal(decode(v.text) as string);
      if (JSON.stringify(actual) !== JSON.stringify(v.expect)) {
        mismatches.push({ text: v.text, expected: v.expect, actual });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("suggestSeverity matches every vector", () => {
    const mismatches: unknown[] = [];
    for (const v of vectors.severity) {
      const actual = suggestSeverity(
        v.detection as Parameters<typeof suggestSeverity>[0],
        v.affected_production
      );
      if (actual !== v.expect) {
        mismatches.push({ detection: v.detection, prod: v.affected_production, expected: v.expect, actual });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("pins the `\\berror:\\b` word-boundary behaviour explicitly", () => {
    // NOT an endorsement — a pin. `\berror:\b` needs a word char right after the
    // colon, so the canonical "error: <message>" form never matches. Measured in prd
    // 2026-08-21: 307 of the 412 `type='fix'` observations containing "error:" are
    // this non-matching form; 1 is the matching form. Retuning it is a live-pipeline
    // behaviour change, surfaced as a decision rather than slipped in here. If it IS
    // retuned, this test is the thing that makes the change visible.
    expect(detectFixSignal("error: connection refused").detected).toBe(false);
    expect(detectFixSignal("error:EACCES permission denied").detected).toBe(true);
  });
});
