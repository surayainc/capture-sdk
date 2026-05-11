/**
 * Bug / problem / broken signal detection.
 *
 * The fix_metrics handoff calls for auto-detection of bug-like signals
 * in conversation so the skill can prompt the operator with "looks
 * like a bug — start tracking with /fix-start?" The detection is
 * heuristic (keyword + pattern matching), not LLM-driven, because:
 *   1. The skill runs frequently and an LLM call per detection would
 *      be expensive + slow + noisy.
 *   2. False positives are fine — the prompt is "do you want to track?"
 *      not "I started tracking." The operator says yes or ignores.
 *   3. Heuristics are easier to tune as we observe what slips through.
 *
 * Returns a confidence in [0, 1]. Above 0.5 → fire the prompt. Below
 * 0.5 → quiet. Tunable by adding patterns over time.
 */

export type Signal =
  | "bug"
  | "problem"
  | "broken"
  | "error"
  | "regression"
  | "unclear";

export interface SignalDetection {
  detected: boolean;
  signal: Signal;
  confidence: number;
  matched_pattern?: string;
}

// Patterns ordered roughly by strength. First-match wins.
const PATTERNS: Array<{
  pattern: RegExp;
  signal: Signal;
  confidence: number;
  label: string;
}> = [
  // Strong: explicit stack-trace / error-class signatures.
  { pattern: /\bTypeError\b/, signal: "error", confidence: 0.95, label: "TypeError" },
  { pattern: /\bReferenceError\b/, signal: "error", confidence: 0.95, label: "ReferenceError" },
  { pattern: /\bSyntaxError\b/, signal: "error", confidence: 0.95, label: "SyntaxError" },
  { pattern: /\bUncaught\b/, signal: "error", confidence: 0.9, label: "Uncaught" },
  { pattern: /\bTraceback\b/, signal: "error", confidence: 0.9, label: "Traceback (Python)" },
  { pattern: /\bsegfault\b/i, signal: "broken", confidence: 0.9, label: "segfault" },
  { pattern: /\bcore dumped\b/i, signal: "broken", confidence: 0.9, label: "core dumped" },

  // Strong: build / test / CI failure markers.
  { pattern: /\bFAILED\b/, signal: "broken", confidence: 0.85, label: "FAILED" },
  { pattern: /\bfailing\s+(test|spec)\b/i, signal: "broken", confidence: 0.85, label: "failing test" },
  { pattern: /\b(build|compile)\s+(failed|error)\b/i, signal: "broken", confidence: 0.85, label: "build failed" },
  { pattern: /\bassert(ion)?\s+(failed|error)\b/i, signal: "broken", confidence: 0.8, label: "assertion failed" },

  // Medium: incident language. Looser word-gap so "production is down"
  // / "prod went down" both fire — typical incident phrasing.
  { pattern: /\b(production|prod)\b.{0,15}\b(down|broken|outage)\b/i, signal: "broken", confidence: 0.9, label: "production down" },
  { pattern: /\b(it'?s|its)\s+broken\b/i, signal: "broken", confidence: 0.8, label: "it's broken" },
  { pattern: /\bdoesn'?t\s+work\b/i, signal: "broken", confidence: 0.7, label: "doesn't work" },
  { pattern: /\bnot\s+working\b/i, signal: "broken", confidence: 0.7, label: "not working" },
  { pattern: /\bregression\b/i, signal: "regression", confidence: 0.8, label: "regression" },

  // Medium: bug-like vocabulary.
  { pattern: /\bbug\b/i, signal: "bug", confidence: 0.65, label: "bug" },
  { pattern: /\bbroken\b/i, signal: "broken", confidence: 0.65, label: "broken" },
  { pattern: /\bproblem\b/i, signal: "problem", confidence: 0.5, label: "problem" },

  // Weak: generic "error" needs a partner to fire.
  { pattern: /\berror:\b/i, signal: "error", confidence: 0.7, label: "error:" },
  { pattern: /\bexception\b/i, signal: "error", confidence: 0.6, label: "exception" },
  { pattern: /\bissue\b/i, signal: "problem", confidence: 0.4, label: "issue" },
];

/**
 * Inspect a conversation segment (or any text). Returns the strongest
 * signal found. Caller decides whether confidence > threshold to act.
 */
export function detectFixSignal(text: string): SignalDetection {
  if (!text || typeof text !== "string") {
    return { detected: false, signal: "unclear", confidence: 0 };
  }
  let best: SignalDetection = { detected: false, signal: "unclear", confidence: 0 };
  for (const { pattern, signal, confidence, label } of PATTERNS) {
    if (pattern.test(text) && confidence > best.confidence) {
      best = {
        detected: true,
        signal,
        confidence,
        matched_pattern: label,
      };
    }
  }
  return best;
}

/** Default threshold for "prompt the operator to track this fix." */
export const PROMPT_THRESHOLD = 0.5;

/**
 * Suggested severity given a detection. Heuristic mapping — operator
 * confirms or overrides at /fix-end time. The handoff calls for the
 * agent to "propose severity based on conversation context"; this is
 * the local-only first pass.
 */
export function suggestSeverity(
  detection: SignalDetection,
  affectedProduction: boolean
): "low" | "medium" | "high" | "critical" {
  if (affectedProduction) return "critical";
  if (detection.signal === "regression") return "high";
  if (detection.signal === "error" && detection.confidence >= 0.9) return "high";
  if (detection.signal === "broken" && detection.confidence >= 0.85) return "high";
  if (detection.confidence >= 0.6) return "medium";
  return "low";
}
