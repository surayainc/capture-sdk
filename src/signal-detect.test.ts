import { describe, it, expect } from "vitest";
import {
  detectFixSignal,
  suggestSeverity,
  PROMPT_THRESHOLD,
} from "./signal-detect.js";

describe("detectFixSignal", () => {
  it("returns no detection for empty/non-string input", () => {
    expect(detectFixSignal("")).toEqual({
      detected: false,
      signal: "unclear",
      confidence: 0,
    });
    expect(detectFixSignal(null as unknown as string).detected).toBe(false);
  });

  it("returns no detection for benign text", () => {
    const r = detectFixSignal("Refactoring the auth flow to use NextAuth v5.");
    expect(r.detected).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it("picks the strongest signal when multiple patterns hit", () => {
    const r = detectFixSignal(
      "Saw a TypeError in the build, also looks like a regression"
    );
    // TypeError (0.95) beats regression (0.80)
    expect(r.signal).toBe("error");
    expect(r.matched_pattern).toBe("TypeError");
    expect(r.confidence).toBeCloseTo(0.95);
  });

  it("detects production-outage language with high confidence", () => {
    const r = detectFixSignal("Production is down, urgent");
    expect(r.detected).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("treats a bare 'issue' as below the prompt threshold", () => {
    const r = detectFixSignal("There's an issue with the layout");
    expect(r.confidence).toBeLessThan(PROMPT_THRESHOLD);
  });

  it("treats 'doesn't work' as above the prompt threshold", () => {
    const r = detectFixSignal("the save button doesn't work");
    expect(r.confidence).toBeGreaterThan(PROMPT_THRESHOLD);
    expect(r.signal).toBe("broken");
  });

  it("returns a matched_pattern label for the strongest hit", () => {
    const r = detectFixSignal("Build failed in CI");
    expect(r.matched_pattern).toBe("build failed");
  });
});

describe("suggestSeverity", () => {
  it("returns critical when production is affected, regardless of signal", () => {
    const detection = detectFixSignal("bug in checkout");
    expect(suggestSeverity(detection, true)).toBe("critical");
  });

  it("returns high for confirmed regression", () => {
    const detection = detectFixSignal("regression in the auth callback");
    expect(suggestSeverity(detection, false)).toBe("high");
  });

  it("returns high for strong error signal", () => {
    const detection = detectFixSignal("TypeError: cannot read property of null");
    expect(suggestSeverity(detection, false)).toBe("high");
  });

  it("returns medium for weaker bug language", () => {
    const detection = detectFixSignal("looks like a bug in the form");
    // bug = 0.65 → medium
    expect(suggestSeverity(detection, false)).toBe("medium");
  });

  it("returns low when no detection or low confidence", () => {
    const detection = detectFixSignal("Refactor scheduled for tomorrow");
    expect(suggestSeverity(detection, false)).toBe("low");
  });
});
