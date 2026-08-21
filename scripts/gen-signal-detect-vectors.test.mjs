/**
 * RED/GREEN fixture for the vector generator's own coverage contract.
 *
 * The generator REFUSES to emit a fixture that under-covers the heuristic. That
 * refusal is the thing standing between "we have golden vectors" and "we have
 * golden vectors that would actually notice". A refusal path that is never
 * exercised is indistinguishable from one that is broken, so it is tested here
 * rather than assumed.
 *
 * (It is not hypothetical: on its first real run the generator refused, correctly,
 * because the `error:` pattern had no probe that could match it — which is how the
 * `\berror:\b` word-boundary defect was found.)
 */
import { describe, it, expect } from "vitest";
import {
  buildVectors,
  findCoverageGaps,
  labelsFromSource,
  patternsFromSource,
  buildTieProbes,
  serialize,
  encodeInput,
  decodeInput,
} from "./gen-signal-detect-vectors.mjs";

/** A stand-in implementation with two labelled patterns. */
const FAKE_SRC = `
  { pattern: /\\balpha\\b/, signal: "bug", confidence: 0.9, label: "alpha" },
  { pattern: /\\bbeta\\b/i, signal: "broken", confidence: 0.7, label: "beta" },
`;

const fakeImpl = {
  detectFixSignal(text) {
    if (typeof text !== "string" || !text) {
      return { detected: false, signal: "unclear", confidence: 0 };
    }
    if (/\balpha\b/.test(text)) {
      return { detected: true, signal: "bug", confidence: 0.9, matched_pattern: "alpha" };
    }
    if (/\bbeta\b/i.test(text)) {
      return { detected: true, signal: "broken", confidence: 0.7, matched_pattern: "beta" };
    }
    return { detected: false, signal: "unclear", confidence: 0 };
  },
  suggestSeverity(detection, affectedProduction) {
    if (affectedProduction) return "critical";
    if (detection.signal === "regression") return "high";
    if (detection.signal === "error" && detection.confidence >= 0.9) return "high";
    if (detection.signal === "broken" && detection.confidence >= 0.85) return "high";
    if (detection.confidence >= 0.6) return "medium";
    return "low";
  },
};

describe("labelsFromSource", () => {
  it("extracts every declared pattern label", () => {
    expect(labelsFromSource(FAKE_SRC)).toEqual(["alpha", "beta"]);
  });

  it("returns empty for a source with no labels", () => {
    expect(labelsFromSource("const x = 1;")).toEqual([]);
  });
});

describe("findCoverageGaps — the refusal contract", () => {
  const { detect, severity } = buildVectors(fakeImpl);

  it("GREEN: reports no gap when the real corpus covers the real source", () => {
    // The shipped corpus vs the shipped implementation: this is the state the
    // generator must be in to emit at all.
    const implSrc = FAKE_SRC;
    // Synthesise detect vectors that DO match both fake labels.
    const covering = [
      { text: "alpha", expect: fakeImpl.detectFixSignal("alpha") },
      { text: "beta", expect: fakeImpl.detectFixSignal("beta") },
      { text: "", expect: fakeImpl.detectFixSignal("") },
    ];
    const coveringSeverity = [
      { detection: { detected: true, signal: "bug", confidence: 0.9 }, affected_production: false, expect: "medium" },
      { detection: { detected: true, signal: "bug", confidence: 0.9 }, affected_production: true, expect: "critical" },
      { detection: { detected: true, signal: "broken", confidence: 0.9 }, affected_production: false, expect: "high" },
      { detection: { detected: false, signal: "unclear", confidence: 0 }, affected_production: false, expect: "low" },
    ];
    expect(findCoverageGaps(implSrc, covering, coveringSeverity)).toEqual([]);
  });

  it("RED: a pattern with no matching probe is reported as a gap", () => {
    // Drop the vector that covers "beta" — exactly the shape of "someone added a
    // pattern and never wrote a probe for it".
    const covering = [
      { text: "alpha", expect: fakeImpl.detectFixSignal("alpha") },
      { text: "", expect: fakeImpl.detectFixSignal("") },
    ];
    const coveringSeverity = [
      { detection: {}, affected_production: false, expect: "low" },
      { detection: {}, affected_production: false, expect: "medium" },
      { detection: {}, affected_production: false, expect: "high" },
      { detection: {}, affected_production: false, expect: "critical" },
    ];
    const gaps = findCoverageGaps(FAKE_SRC, covering, coveringSeverity);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.join(" ")).toContain("beta");
  });

  it("RED: an unreachable severity tier is reported as a gap", () => {
    const covering = [
      { text: "alpha", expect: fakeImpl.detectFixSignal("alpha") },
      { text: "beta", expect: fakeImpl.detectFixSignal("beta") },
      { text: "", expect: fakeImpl.detectFixSignal("") },
    ];
    // No vector produces "critical".
    const coveringSeverity = [
      { detection: {}, affected_production: false, expect: "low" },
      { detection: {}, affected_production: false, expect: "medium" },
      { detection: {}, affected_production: false, expect: "high" },
    ];
    expect(findCoverageGaps(FAKE_SRC, covering, coveringSeverity).join(" ")).toContain("critical");
  });

  it("RED: a source with no extractable labels is reported, not silently accepted", () => {
    // The failure mode that would otherwise render as a healthy empty state: the
    // label regex stops matching (the patterns get refactored), every label is
    // trivially "covered", and the guard reports green over zero coverage.
    const gaps = findCoverageGaps("no labels here", detect, severity);
    expect(gaps.join(" ")).toContain("could not extract any PATTERNS");
  });
});

describe("serialize", () => {
  it("is deterministic — byte-identity across repos is the invariant", () => {
    const a = serialize({ detect: [], severity: [], promptThreshold: 0.5 });
    const b = serialize({ detect: [], severity: [], promptThreshold: 0.5 });
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("round-trips `undefined` through JSON so the mirror replays the same input", () => {
    // JSON.stringify would drop `undefined` and the mirror would replay a DIFFERENT
    // input than the canonical side did — a silently weaker vector.
    expect(decodeInput(encodeInput(undefined))).toBe(undefined);
    expect(JSON.parse(JSON.stringify(encodeInput(undefined)))).toEqual({ __undefined__: true });
    expect(decodeInput(encodeInput(null))).toBe(null);
    expect(decodeInput(encodeInput("bug"))).toBe("bug");
  });
});

describe("patternsFromSource — the structural fingerprint", () => {
  it("extracts every PATTERNS entry in order, with regex/flags/signal/confidence/label", () => {
    expect(patternsFromSource(FAKE_SRC)).toEqual([
      { source: "\\balpha\\b", flags: "", signal: "bug", confidence: 0.9, label: "alpha" },
      { source: "\\bbeta\\b", flags: "i", signal: "broken", confidence: 0.7, label: "beta" },
    ]);
  });

  it("is empty for a source with no PATTERNS entries", () => {
    expect(patternsFromSource("const x = 1;")).toEqual([]);
  });

  it("moves when two entries are transposed — order is part of the signature", () => {
    const swapped = `
      { pattern: /\\bbeta\\b/i, signal: "broken", confidence: 0.7, label: "beta" },
      { pattern: /\\balpha\\b/, signal: "bug", confidence: 0.9, label: "alpha" },
    `;
    expect(patternsFromSource(swapped)).not.toEqual(patternsFromSource(FAKE_SRC));
    expect(patternsFromSource(swapped).map((p) => p.label)).toEqual(["beta", "alpha"]);
  });
});

describe("findCoverageGaps — the NEW-PATTERN-under-an-existing-LABEL survivor", () => {
  // Two patterns share the label "issue" but differ in confidence — exactly the
  // /\bflaky\b/i @0.9 "issue" case. A label-keyed check would call "issue" covered by
  // the 0.4 probe and let the 0.9 behaviour ship unexercised. Per-pattern coverage
  // (keyed on regex + signal + confidence) must demand a probe the 0.9 pattern wins on.
  const DUP_LABEL_SRC = `
    { pattern: /\\bflaky\\b/i, signal: "problem", confidence: 0.9, label: "issue" },
    { pattern: /\\bissue\\b/i, signal: "problem", confidence: 0.4, label: "issue" },
  `;
  const severityAllTiers = [
    { detection: {}, affected_production: false, expect: "low" },
    { detection: {}, affected_production: false, expect: "medium" },
    { detection: {}, affected_production: false, expect: "high" },
    { detection: {}, affected_production: false, expect: "critical" },
  ];

  it("RED: covering only the 0.4 'issue' probe leaves the 0.9 'flaky' pattern a gap", () => {
    const onlyLowIssue = [
      { text: "there is an issue with the cache", expect: { detected: true, signal: "problem", confidence: 0.4, matched_pattern: "issue" } },
      { text: "", expect: { detected: false, signal: "unclear", confidence: 0 } },
    ];
    const gaps = findCoverageGaps(DUP_LABEL_SRC, onlyLowIssue, severityAllTiers);
    expect(gaps.length).toBeGreaterThan(0);
    // The gap must name the UNCOVERED high-confidence pattern, not the label alone.
    expect(gaps.join(" ")).toContain("flaky");
    expect(gaps.join(" ")).toContain("0.9");
  });

  it("GREEN: adding a probe the 0.9 'flaky' pattern wins on closes the gap", () => {
    const covered = [
      { text: "the test is flaky", expect: { detected: true, signal: "problem", confidence: 0.9, matched_pattern: "issue" } },
      { text: "there is an issue with the cache", expect: { detected: true, signal: "problem", confidence: 0.4, matched_pattern: "issue" } },
      { text: "", expect: { detected: false, signal: "unclear", confidence: 0 } },
    ];
    expect(findCoverageGaps(DUP_LABEL_SRC, covered, severityAllTiers)).toEqual([]);
  });
});

describe("findCoverageGaps — tie-probe integrity", () => {
  const validSrc = FAKE_SRC;
  const coveringDetect = [
    { text: "alpha", expect: { detected: true, signal: "bug", confidence: 0.9, matched_pattern: "alpha" } },
    { text: "beta", expect: { detected: true, signal: "broken", confidence: 0.7, matched_pattern: "beta" } },
    { text: "", expect: { detected: false, signal: "unclear", confidence: 0 } },
  ];
  const severityAllTiers = [
    { detection: {}, affected_production: false, expect: "low" },
    { detection: {}, affected_production: false, expect: "medium" },
    { detection: {}, affected_production: false, expect: "high" },
    { detection: {}, affected_production: false, expect: "critical" },
  ];

  it("RED: a tie-probe that resolved ABOVE its group confidence is a gap", () => {
    // Simulates a newline-join that accidentally matched a higher pattern: the probe
    // can no longer observe intra-group order, so the generator must refuse.
    const badTie = [{ confidence: 0.8, tieInput: "…", expect: { detected: true, signal: "error", confidence: 0.95 } }];
    const gaps = findCoverageGaps(validSrc, coveringDetect, severityAllTiers, badTie);
    expect(gaps.join(" ")).toContain("tie-probe for confidence group 0.8");
  });

  it("GREEN: a tie-probe resolving AT its group confidence is accepted", () => {
    const goodTie = [{ confidence: 0.8, tieInput: "…", expect: { detected: true, signal: "broken", confidence: 0.8 } }];
    expect(findCoverageGaps(validSrc, coveringDetect, severityAllTiers, goodTie)).toEqual([]);
  });
});

describe("buildTieProbes — one synthetic probe per equal-confidence group", () => {
  // A stand-in impl that puts two REAL probe strings in the same 0.8 group. The winner
  // of the joined tie-input is decided by which the impl matches FIRST — so flipping the
  // impl's match order flips the tie-probe's expected output. That flip is the whole
  // guard: reorder the group and the vector — and the artifact — move.
  const makeImpl = (regressionFirst) => ({
    detectFixSignal(text) {
      if (typeof text !== "string" || !text) return { detected: false, signal: "unclear", confidence: 0 };
      const hasAssert = /assertion failed/.test(text);
      const hasReg = /regression/.test(text);
      const assertDet = { detected: true, signal: "broken", confidence: 0.8, matched_pattern: "assertion failed" };
      const regDet = { detected: true, signal: "regression", confidence: 0.8, matched_pattern: "regression" };
      if (regressionFirst) {
        if (hasReg) return regDet;
        if (hasAssert) return assertDet;
      } else {
        if (hasAssert) return assertDet;
        if (hasReg) return regDet;
      }
      return { detected: false, signal: "unclear", confidence: 0 };
    },
  });

  it("emits exactly one tie-probe for the single 0.8 group, joining its members", () => {
    const probes = buildTieProbes(makeImpl(false));
    expect(probes).toHaveLength(1);
    expect(probes[0].confidence).toBe(0.8);
    expect(probes[0].tieInput).toContain("assertion failed");
    expect(probes[0].tieInput).toContain("regression");
  });

  it("the tie-probe's winner FLIPS when the group is reordered — the reorder catch", () => {
    const canonical = buildTieProbes(makeImpl(false))[0];
    const reordered = buildTieProbes(makeImpl(true))[0];
    expect(canonical.expect.matched_pattern).toBe("assertion failed");
    expect(canonical.expect.signal).toBe("broken");
    expect(reordered.expect.matched_pattern).toBe("regression");
    expect(reordered.expect.signal).toBe("regression");
    // Because the expected output differs, the serialised vector — and thus the
    // artifact bytes and the mirror replay — differ. That is the guard.
    expect(JSON.stringify(canonical.expect)).not.toBe(JSON.stringify(reordered.expect));
  });
});
