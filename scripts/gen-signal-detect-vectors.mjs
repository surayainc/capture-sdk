#!/usr/bin/env node
/**
 * gen-signal-detect-vectors.mjs — CANONICAL generator for the signal-detect
 * cross-repo drift fixture (`src/signal-detect.vectors.json`).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * `src/signal-detect.ts` (this repo, CANONICAL) is hand-mirrored by
 * `suraya-brain/src/lib/severity-derive.ts`. The brain cannot import this package
 * (the SDK is the brain's CLIENT — depending on it inverts the arrow and adds
 * version skew between a deployed brain and the SDK its clients run), so the
 * heuristic is re-expressed there. Both files carry a "keep in sync" comment and
 * NOTHING enforced it. Measured in prd 2026-08-21: the brain's derive path wrote
 * 108 of the 109 rows in `fix_metrics`. A divergence would mis-stamp severity —
 * the single largest term in the importance formula (0.30 weight).
 *
 * This artifact closes that. It is the SDK-side half of the guard:
 *
 *   CANONICAL side (here)  — regenerate + `git diff --exit-code` (Gate A). Any change
 *                            to detectFixSignal / suggestSeverity / PATTERNS that
 *                            alters BEHAVIOUR turns CI red until the fixture is
 *                            regenerated, which changes the artifact's bytes.
 *   MIRROR side (brain)    — vendors these bytes and replays EVERY vector through its
 *                            OWN implementation. Brain-side drift → brain CI red.
 *
 * ── BEHAVIOUR-DERIVED, NOT SOURCE-DERIVED (deliberate) ───────────────────────
 * This artifact deliberately does NOT embed a sha256 of signal-detect.ts. It records
 * only INPUT → OUTPUT. Rationale, measured 2026-08-21 while building this guard:
 *   - `suggestSeverity` is byte-different across the two repos TODAY (`FixSeverity`
 *     there vs the inline `"low"|"medium"|...` union here) while being behaviourally
 *     identical — a source-hash guard would be RED on day one, on a non-difference.
 *   - The same is true of the importance pair (named constants vs inlined literals).
 * A source-hash guard would have to be silenced to go green, and a silenced guard is
 * not a guard. A behaviour fixture stays quiet exactly when nothing behavioural moved
 * (reformat / comment / rename → byte-identical output → no re-vendor churn) and goes
 * red exactly when it did.
 *
 * ── COVERAGE IS SELF-ENFORCING ───────────────────────────────────────────────
 * The generator REFUSES to emit (exit 1) if any `label:` in PATTERNS has no probe
 * vector that actually matches it. Add a pattern without a probe and you cannot
 * generate — so the fixture cannot silently under-cover as the heuristic grows.
 * `findCoverageGaps` is exported and unit-tested (gen-signal-detect-vectors.test.mjs)
 * so the refusal path is exercised, not assumed. It is not hypothetical: on its first
 * run it refused, correctly, and surfaced a live defect in the `error:` pattern.
 *
 * The corpus is NOT random. Every class below exists because a mutation of the
 * implementation survived without it (mutation-tested 2026-08-21, 4/4 classes caught):
 *   1. one probe per PATTERNS label            → catches a dropped/retuned pattern
 *   2. multi-signal strings                    → catches max-confidence ordering changes
 *   3. near-miss / word-boundary strings       → catches \b removal, casing-flag flips
 *   4. the production word-gap boundary (15)   → catches `.{0,15}` being widened
 *   5. junk / non-string inputs                → catches the input-validation guard
 *   6. a SYNTHETIC suggestSeverity grid        → catches threshold moves (0.9/0.85/0.6)
 *      that no natural-text corpus reaches (that mutation produced only 4 diffs, ALL
 *      of them in this grid — without it the mutation would have shipped green)
 *
 * Usage:
 *   npm run gen:vectors           # build + regenerate the fixture
 *   npm run gen:vectors:check     # build + assert the committed fixture is fresh
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
export const IMPL_SRC = join(repoRoot, "src", "signal-detect.ts");
export const OUT = join(repoRoot, "src", "signal-detect.vectors.json");
export const DIST_IMPL = join(repoRoot, "dist", "signal-detect.js");

/** Class 1: one probe per PATTERNS label (coverage-enforced by findCoverageGaps). */
const PROBES_PER_PATTERN = [
  "TypeError: x is not a function",
  "ReferenceError: y is not defined",
  "SyntaxError: unexpected token }",
  "Uncaught (in promise) whatever",
  "Traceback (most recent call last):",
  "the process died with a segfault",
  "SIGSEGV: core dumped",
  "FAILED",
  "one failing test in the suite",
  "the build failed on main",
  "assertion failed: expected 1 to be 2",
  "production is down",
  "it's broken",
  "this doesn't work",
  "the poller is not working",
  "a regression from last week",
  "there is a bug in the parser",
  "the pipeline is broken",
  "we have a problem with the queue",
  "an exception escaped the handler",
  "there is an issue with the cache",
  // NOTE — this probe looks contrived ON PURPOSE. `/\berror:\b/i` requires a WORD
  // character immediately after the colon, so the canonical "error: <message>"
  // (colon-SPACE) never matches; only "error:EACCES"-style forms do. Measured in prd
  // 2026-08-21: of 412 `type='fix'` observations containing "error:", 307 are the
  // colon-space form and exactly 1 is this matching form. This fixture LOCKS the
  // behaviour as it is; it does not endorse it. See the near-miss vectors below and
  // the PR body — retuning the pattern is a live-pipeline behaviour change and is
  // being surfaced as a decision, not slipped in under a drift guard.
  "error:EACCES permission denied",
];

/** Class 2: multi-signal — locks first-match-by-MAX-confidence ordering. */
const MULTI_SIGNAL = [
  "TypeError and also a bug and production is down",
  "bug problem issue exception",
  "regression: the build failed with a TypeError",
  "issue with a segfault",
  "problem: not working",
  "FAILED: assertion failed in a failing test",
  "an issue, a problem, and a bug walk into a bar",
  "exception -> Uncaught",
];

/** Class 3: near-miss / boundary / casing — locks \b anchors and the /i flags. */
const NEAR_MISS = [
  "",
  " ",
  "a perfectly ordinary commit message",
  "bugs", // \bbug\b must NOT match
  "buggy",
  "debug",
  "debugger",
  "brokenness",
  "unbroken",
  "reissue",
  "issues", // \bissue\b must NOT match
  "Exceptional",
  "errors:",
  "error without a colon",
  // The `\berror:\b` word-boundary trap, pinned as vectors so a future retune is a
  // VISIBLE fixture diff rather than a silent behaviour change. All three currently
  // detect NOTHING (see the note in PROBES_PER_PATTERN).
  "error: connection refused",
  "ERROR: deploy failed",
  "error: ",
  "typeerror lowercase", // TypeError is case-SENSITIVE
  "failed", // \bFAILED\b is case-SENSITIVE
  "SEGFAULT", // segfault is case-INsensitive
  "It'S BrOkEn",
  "its broken",
  "doesnt work",
  "production", // needs the partner word
  "down",
  "\u{1F41B} bug",
  "bug\n\nTypeError",
  "  \t\n bug \t\n  ",
];

/**
 * Class 4: the `.{0,15}` production word-gap boundary. Exactly 15 filler chars
 * must match; 16 must not. Locks the gap width against silent widening.
 */
const PROD_GAP = [
  "production is down",
  "prod went down",
  "production outage",
  "prod broken",
  `production ${"x".repeat(15)} down`, // gap == 15 → matches
  `production ${"x".repeat(16)} down`, // gap == 16 → must NOT match
];

/**
 * Class 5: non-string / junk — locks the `!text || typeof text !== "string"` guard.
 *
 * `["bug"]` and `["production is down"]` are load-bearing, not padding. Without the
 * type guard, `RegExp.test(value)` COERCES its argument, and `String(["bug"])` is
 * `"bug"` — so an array input would be detected as a real bug signal. Every scalar
 * here (`null`, `123`, `{}`, `[]`) coerces to a string that matches no pattern, so
 * scalars alone CANNOT tell the guarded and unguarded implementations apart: deleting
 * the guard was mutation-tested against a scalar-only junk set and survived, green.
 * The array vectors are what make that mutation detectable.
 */
const JUNK = [null, undefined, 123, 0, true, false, {}, [], ["bug"], ["production is down"]];

/**
 * Case variants of every per-pattern probe, generated rather than hand-listed so a
 * newly added pattern gets its case coverage automatically.
 *
 * Load-bearing: dropping the `/i` flag from `\bbroken\b` was mutation-tested and
 * SURVIVED against the hand-written corpus, because every bare-"broken" probe in it
 * was lowercase and every uppercase one ("It'S BrOkEn") is won by a different,
 * higher-confidence pattern. Uppercasing shifts which pattern wins for the
 * case-SENSITIVE ones (TypeError / FAILED / Uncaught / Traceback), so these vectors
 * lock case-sensitivity in BOTH directions at once.
 */
const CASE_VARIANTS = [
  ...PROBES_PER_PATTERN.map((s) => s.toUpperCase()),
  ...PROBES_PER_PATTERN.map((s) => s.toLowerCase()),
];

const DETECT_INPUTS = [
  ...PROBES_PER_PATTERN,
  ...CASE_VARIANTS,
  ...MULTI_SIGNAL,
  ...NEAR_MISS,
  ...PROD_GAP,
];

/**
 * Class 6: SYNTHETIC suggestSeverity grid. Natural text cannot reach every
 * (signal, confidence) cell — notably the 0.89/0.90 and 0.84/0.85 edges the `>=`
 * comparisons turn on. Includes an OUT-OF-DOMAIN signal on purpose: the analogous
 * fallback branch in the importance formula was caught during mutation testing ONLY
 * by an out-of-domain input.
 */
const SYNTH_SIGNALS = ["bug", "problem", "broken", "error", "regression", "unclear", "__unknown__"];
const SYNTH_CONFIDENCES = [0, 0.39, 0.4, 0.5, 0.59, 0.6, 0.65, 0.79, 0.8, 0.84, 0.85, 0.89, 0.9, 0.95, 1];

/** JSON has no `undefined`; encode it so the mirror replays the SAME input. */
export function encodeInput(v) {
  return v === undefined ? { __undefined__: true } : v;
}
export function decodeInput(v) {
  return v && typeof v === "object" && v.__undefined__ === true ? undefined : v;
}

/** Build the full vector set from an implementation module. Pure. */
export function buildVectors({ detectFixSignal, suggestSeverity }) {
  const detect = DETECT_INPUTS.concat(JUNK).map((text) => ({
    text: encodeInput(text),
    expect: detectFixSignal(text),
  }));

  const severity = [];
  for (const text of DETECT_INPUTS) {
    const detection = detectFixSignal(text);
    for (const affected_production of [true, false]) {
      severity.push({
        detection,
        affected_production,
        expect: suggestSeverity(detection, affected_production),
      });
    }
  }
  for (const signal of SYNTH_SIGNALS) {
    for (const confidence of SYNTH_CONFIDENCES) {
      for (const detected of [true, false]) {
        for (const affected_production of [true, false]) {
          const detection = { detected, signal, confidence };
          severity.push({
            detection,
            affected_production,
            expect: suggestSeverity(detection, affected_production),
          });
        }
      }
    }
  }
  return { detect, severity };
}

/** Every `label:` declared in the implementation source. */
export function labelsFromSource(implSrc) {
  return [...implSrc.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The coverage contract. Returns a list of human-readable gaps; empty means the
 * fixture is strong enough to emit. Exported so the refusal path is TESTABLE —
 * a guard whose failure mode is never exercised is not a guard.
 */
export function findCoverageGaps(implSrc, detect, severity) {
  const gaps = [];
  const labels = labelsFromSource(implSrc);
  if (labels.length === 0) {
    gaps.push("could not extract any PATTERNS `label:` from the implementation source");
  }
  const matched = new Set(detect.map((v) => v.expect && v.expect.matched_pattern).filter(Boolean));
  const uncovered = labels.filter((l) => !matched.has(l));
  if (uncovered.length > 0) {
    gaps.push(
      `PATTERNS labels with no probe vector that matches them: ${uncovered.join(", ")}` +
        " → add a probe string to PROBES_PER_PATTERN that this pattern wins on."
    );
  }
  const tiers = new Set(severity.map((v) => v.expect));
  for (const t of ["low", "medium", "high", "critical"]) {
    if (!tiers.has(t)) gaps.push(`no vector produces severity "${t}"`);
  }
  if (!detect.some((v) => v.expect.detected === true)) gaps.push("no vector detects a signal");
  if (!detect.some((v) => v.expect.detected === false)) gaps.push("no vector fails to detect");
  return gaps;
}

/** Stable, deterministic serialisation — byte-identity across repos is the invariant. */
export function serialize({ detect, severity, promptThreshold }) {
  return (
    JSON.stringify(
      {
        _source:
          "surayainc/capture-sdk src/signal-detect.ts — CANONICAL. Generated by " +
          "scripts/gen-signal-detect-vectors.mjs (Gate A: regenerate + git diff). Vendored " +
          "byte-for-byte into surayainc/suraya-brain src/lib/vendor/signal-detect.vectors.json, " +
          "where severity-derive.ts (the hand-mirror) replays EVERY vector through its own " +
          "implementation. Edit the heuristic HERE, regenerate, re-vendor there.",
        _shape:
          "BEHAVIOUR fixture (input -> output). Deliberately carries NO source hash: the two " +
          "implementations are byte-different but behaviourally identical, so a source hash " +
          "would be red on a non-difference.",
        version: 1,
        prompt_threshold: promptThreshold,
        detect,
        severity,
      },
      null,
      2
    ) + "\n"
  );
}

async function main() {
  let impl;
  try {
    impl = await import(pathToFileURL(DIST_IMPL).href);
  } catch (err) {
    console.error(
      "[gen-signal-detect-vectors] cannot load dist/signal-detect.js — run `npm run build` first.\n" +
        String(err && err.message ? err.message : err)
    );
    process.exit(1);
  }

  const implSrc = readFileSync(IMPL_SRC, "utf8");
  const { detect, severity } = buildVectors(impl);

  const gaps = findCoverageGaps(implSrc, detect, severity);
  if (gaps.length > 0) {
    console.error("[gen-signal-detect-vectors] REFUSING to emit — coverage gaps:");
    for (const g of gaps) console.error("  - " + g);
    process.exit(1);
  }

  const serialized = serialize({ detect, severity, promptThreshold: impl.PROMPT_THRESHOLD });
  const labelCount = labelsFromSource(implSrc).length;

  if (process.argv.includes("--check")) {
    let existing = null;
    try {
      existing = readFileSync(OUT, "utf8");
    } catch {
      console.error(`[gen-signal-detect-vectors] MISSING ${OUT} — run \`npm run gen:vectors\`.`);
      process.exit(1);
    }
    if (existing !== serialized) {
      console.error(
        "[gen-signal-detect-vectors] STALE — src/signal-detect.vectors.json does not match the " +
          "current implementation's behaviour.\n" +
          "  → run `npm run gen:vectors`, commit the result, and RE-VENDOR into suraya-brain\n" +
          "    (src/lib/vendor/signal-detect.vectors.json) or the brain mirror will drift."
      );
      process.exit(1);
    }
    console.log(
      `[gen-signal-detect-vectors] fresh — ${detect.length} detect + ${severity.length} severity ` +
        `vectors, ${labelCount}/${labelCount} PATTERNS labels covered.`
    );
    return;
  }

  writeFileSync(OUT, serialized);
  console.log(
    `[gen-signal-detect-vectors] wrote ${OUT}\n  ${detect.length} detect vectors, ` +
      `${severity.length} severity vectors, ${labelCount} PATTERNS labels all covered.`
  );
}

// PORTABLE main-guard. `file://${process.argv[1]}` (the older form elsewhere in this
// repo) is FALSE on win32 — argv[1] is `C:\…`, which never equals the `file:///C:/…`
// that import.meta.url carries — so a script guarded that way silently no-ops on
// windows-latest and its CI step passes VACUOUSLY. pathToFileURL normalises both.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
