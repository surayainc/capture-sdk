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
 * The generator REFUSES to emit (exit 1) if any PATTERN — keyed on its OWN
 * (regex + signal + confidence), NOT just its `label:` string — has no probe vector
 * that both matches its regex and resolves to it. Keying on the label alone was a
 * hole: a NEW pattern reusing an existing label (e.g. `/\bflaky\b/i` @0.9 labelled
 * "issue") left "issue" trivially "covered" and shipped its new behaviour unexercised.
 * Add a pattern without a probe it wins on and you cannot generate — so the fixture
 * cannot silently under-cover as the heuristic grows. `findCoverageGaps` is exported
 * and unit-tested (gen-signal-detect-vectors.test.mjs) so the refusal path is
 * exercised, not assumed. It is not hypothetical: on its first run it refused,
 * correctly, and surfaced a live defect in the `error:` pattern.
 *
 * The corpus is NOT random. Every class below exists because a mutation of the
 * implementation survived without it (mutation-tested 2026-08-21):
 *   1. one probe per PATTERNS label            → catches a dropped/retuned pattern
 *   2. multi-signal strings                    → catches max-confidence ordering changes
 *   3. near-miss / word-boundary strings       → catches \b removal, casing-flag flips
 *   4. the production word-gap boundary (15)   → catches `.{0,15}` being widened
 *   5. junk / non-string inputs                → catches the input-validation guard
 *   6. a SYNTHETIC suggestSeverity grid        → catches threshold moves (0.9/0.85/0.6)
 *      that no natural-text corpus reaches (that mutation produced only 4 diffs, ALL
 *      of them in this grid — without it the mutation would have shipped green)
 *   7. a SYNTHETIC tie-probe per equal-confidence GROUP → catches a REORDER within a
 *      group. Order IS behaviour: detectFixSignal ranks with strict `>`, so ties break
 *      by ARRAY POSITION, and no single-signal input sees it (none matches two
 *      equal-confidence patterns at once). The reorder that flipped 4 prd fix_metrics
 *      rows from medium/`assertion failed` to high/`regression` (both 0.8) left every
 *      prior vector byte-identical — this class is what turns it red.
 *
 * Plus a top-level `pattern_signature`: the ORDERED PATTERNS table
 * (regex + flags + signal + confidence + label), parsed from the impl source. Gate A's
 * git-diff turns red on any reorder, retune, relabel, or a NEW pattern (label-reused or
 * not). It is behaviour-shaped, not a whole-file hash — a reformat/comment/rename of
 * unrelated code leaves it byte-identical, exactly like the vectors.
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

/**
 * Class 7 — TIE-PROBES. One synthetic input per equal-confidence GROUP.
 *
 * `detectFixSignal` ranks with `confidence > best.confidence` — STRICTLY greater — so
 * among patterns sharing a confidence, the FIRST in array order wins. Order is
 * therefore behaviour, but a fixture of single-signal inputs never sees it: no natural
 * input matches two equal-confidence patterns at once, so a reorder inside a group
 * (e.g. `regression` above `assertion failed`, both 0.8) changes real output while
 * leaving every other vector — and the artifact's bytes — untouched.
 *
 * For each group of ≥2 probes at the same confidence we NEWLINE-JOIN their probe
 * strings into ONE input that matches every member (newline so no `.{0,15}` gap or
 * `\b` can span the seam and manufacture a higher match). `detectFixSignal` returns
 * whichever member is first in the CURRENT array order; reorder the group and the
 * winner's `signal` + `matched_pattern` flip, so this vector's expected output — and
 * thus the artifact — changes, and the brain mirror replays a different winner. One
 * probe per group suffices: any adjacent transposition inside the group moves it.
 */
export function buildTieProbes({ detectFixSignal }) {
  const groups = new Map(); // confidence -> [probe, ...] in PATTERNS/probe order
  for (const text of PROBES_PER_PATTERN) {
    const det = detectFixSignal(text);
    if (!det.detected) continue;
    if (!groups.has(det.confidence)) groups.set(det.confidence, []);
    groups.get(det.confidence).push(text);
  }
  const probes = [];
  for (const [confidence, members] of groups) {
    if (members.length < 2) continue; // a group of one has no tie to break
    const tieInput = members.join("\n");
    probes.push({ confidence, tieInput, expect: detectFixSignal(tieInput) });
  }
  return probes;
}

/**
 * Parse the ordered PATTERNS table out of the implementation source: each entry's
 * regex source + flags, signal, confidence, and label, IN ORDER. This is the
 * STRUCTURAL fingerprint the fixture serialises as `pattern_signature`. A reorder, a
 * retune, a relabel, or a NEW pattern (even one reusing an existing label) all change
 * this list, so the canonical Gate A (`--check` → git diff) goes red on any of them.
 * It is parsed from the DECLARED table, not hashed from the whole file, so unrelated
 * reformatting/comments/renames leave it byte-identical — same behaviour-shaped
 * discipline as the vectors.
 */
export function patternsFromSource(implSrc) {
  // The regex-literal body is captured with `[^/\n]+` — a single negated class, LINEAR
  // (no ambiguous alternation / nested quantifier that would backtrack, i.e. no ReDoS).
  // It relies on the invariant that no PATTERNS regex literal contains an unescaped `/`
  // inside it (true for the whole table; a `/` would have to be written `\/`). Do NOT
  // "generalise" this to an alternation over escapes + char-classes — that is exactly the
  // catastrophic-backtracking shape CodeQL js/redos flags, and it buys nothing here.
  const re =
    /\{\s*pattern:\s*\/([^/\n]+)\/([a-z]*)\s*,\s*signal:\s*"([^"]+)"\s*,\s*confidence:\s*([0-9.]+)\s*,\s*label:\s*"([^"]+)"\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(implSrc)) !== null) {
    out.push({ source: m[1], flags: m[2], signal: m[3], confidence: Number(m[4]), label: m[5] });
  }
  return out;
}

/** Build the full vector set from an implementation module. Pure. */
export function buildVectors(impl) {
  const { detectFixSignal, suggestSeverity } = impl;
  const tieProbes = buildTieProbes(impl);

  const detect = DETECT_INPUTS.concat(JUNK)
    .map((text) => ({ text: encodeInput(text), expect: detectFixSignal(text) }))
    .concat(tieProbes.map(({ tieInput, expect }) => ({ text: encodeInput(tieInput), expect })));

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
  return { detect, severity, tieProbes };
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
export function findCoverageGaps(implSrc, detect, severity, tieProbes = []) {
  const gaps = [];
  const patterns = patternsFromSource(implSrc);
  if (patterns.length === 0) {
    gaps.push("could not extract any PATTERNS `pattern:` entry from the implementation source");
  }
  // Per-PATTERN coverage, keyed on the pattern's OWN (regex, signal, confidence) — NOT
  // its label string. A label-keyed check is blind to a new pattern that reuses an
  // existing label (the /\bflaky\b/i @0.9 "issue" survivor): "issue" is already covered
  // by the 0.4 issue probe, so the new 0.9 behaviour would ship unexercised. Requiring a
  // probe that matches THIS regex and resolves to THIS (signal, confidence) closes it.
  const decoded = detect.map((v) => ({ v, t: decodeInput(v.text) }));
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    let re;
    try {
      re = new RegExp(p.source, p.flags);
    } catch {
      gaps.push(`PATTERN #${i} ("${p.label}") has an unparseable regex /${p.source}/${p.flags}`);
      continue;
    }
    const covered = decoded.some(
      ({ v, t }) =>
        typeof t === "string" &&
        re.test(t) &&
        v.expect &&
        v.expect.confidence === p.confidence &&
        v.expect.signal === p.signal
    );
    if (!covered) {
      gaps.push(
        `PATTERN #${i} (/${p.source}/${p.flags} → ${p.signal}@${p.confidence}, label "${p.label}") ` +
          "has no probe vector that matches its regex AND resolves to it — add a probe string this pattern wins on."
      );
    }
  }
  // Tie-probe integrity: each equal-confidence group's synthetic input must resolve AT
  // the group confidence. If a newline-join accidentally pulled in a higher-confidence
  // match, the probe would test the wrong tier and could not observe intra-group order.
  for (const tp of tieProbes) {
    if (!tp.expect || tp.expect.confidence !== tp.confidence) {
      gaps.push(
        `tie-probe for confidence group ${tp.confidence} resolved at ` +
          `${tp.expect && tp.expect.confidence} — the synthetic input matched a higher-confidence ` +
          "pattern and cannot probe intra-group order; adjust the group's probe strings."
      );
    }
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
export function serialize({ detect, severity, promptThreshold, patternSignature }) {
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
          "BEHAVIOUR fixture (input -> output) plus `pattern_signature` — the ORDERED PATTERNS " +
          "table (regex + flags + signal + confidence + label). The vectors pin behaviour; the " +
          "signature pins ORDER + STRUCTURE, which equal-confidence input->output vectors cannot " +
          "see (detectFixSignal ranks with strict `>`, so ties resolve by array position). The " +
          "`detect` set also carries one synthetic TIE-PROBE per equal-confidence group so a " +
          "reorder is observable through BEHAVIOUR (and thus on the brain mirror), not only " +
          "through this signature. Deliberately carries NO source hash: the two implementations " +
          "are byte-different but behaviourally identical, so a source hash would be red on a " +
          "non-difference.",
        version: 1,
        prompt_threshold: promptThreshold,
        pattern_signature: patternSignature ?? [],
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
  const { detect, severity, tieProbes } = buildVectors(impl);
  const patternSignature = patternsFromSource(implSrc);

  const gaps = findCoverageGaps(implSrc, detect, severity, tieProbes);
  if (gaps.length > 0) {
    console.error("[gen-signal-detect-vectors] REFUSING to emit — coverage gaps:");
    for (const g of gaps) console.error("  - " + g);
    process.exit(1);
  }

  const serialized = serialize({
    detect,
    severity,
    promptThreshold: impl.PROMPT_THRESHOLD,
    patternSignature,
  });
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
      `[gen-signal-detect-vectors] fresh — ${detect.length} detect (incl. ${tieProbes.length} ` +
        `tie-probes) + ${severity.length} severity vectors, ${patternSignature.length} PATTERNS ` +
        `signed, ${labelCount}/${labelCount} labels covered.`
    );
    return;
  }

  writeFileSync(OUT, serialized);
  console.log(
    `[gen-signal-detect-vectors] wrote ${OUT}\n  ${detect.length} detect vectors ` +
      `(incl. ${tieProbes.length} equal-confidence tie-probes), ${severity.length} severity ` +
      `vectors, ${patternSignature.length} PATTERNS in pattern_signature.`
  );
}

// PORTABLE main-guard. `file://${process.argv[1]}` (the older form elsewhere in this
// repo) is FALSE on win32 — argv[1] is `C:\…`, which never equals the `file:///C:/…`
// that import.meta.url carries — so a script guarded that way silently no-ops on
// windows-latest and its CI step passes VACUOUSLY. pathToFileURL normalises both.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
