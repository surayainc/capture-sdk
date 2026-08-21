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
