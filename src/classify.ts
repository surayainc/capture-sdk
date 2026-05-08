/**
 * Rule-based observation type classifier for Track A (auto-capture).
 *
 * Cheap, predictable, deliberately stupid. The substrate's clustering
 * job re-classifies if a rule was wrong; the brain's reinforcement
 * scoring naturally weights human-classified (Track B, /capture skill)
 * observations higher because operators only invoke /capture when they
 * know what type they're emitting.
 *
 * Per `governance/brain-conventions.md` — five types: decision, failure,
 * fix, style, deviation. Track A only auto-emits decision / fix /
 * failure (style + deviation require human classification because
 * they're judgment calls that hooks can't make).
 */

import type { ObservationType } from "./types.js";

export interface ClassifyInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: {
    exitCode?: number;
    stderrTail?: string;
  };
}

/**
 * Returns the type to emit, or null if Track A should skip this event.
 */
export function classifyObservation(input: ClassifyInput): ObservationType | null {
  const { toolName, toolInput, toolResult } = input;

  // Bash failure → failure
  if (toolName === "Bash" && toolResult?.exitCode != null && toolResult.exitCode !== 0) {
    return "failure";
  }

  // Bash success: only emit for git-commit-ish or deploy-ish events
  if (toolName === "Bash") {
    const cmd = String(toolInput.command ?? "");
    if (/^git commit\b/.test(cmd)) return "decision";
    if (/^gh pr (create|merge)/.test(cmd)) return "decision";
    return null; // skip — Bash is noisy
  }

  // Edit / Write on architecturally-significant paths → decision
  if (toolName === "Edit" || toolName === "Write") {
    const path = String((toolInput as { file_path?: string }).file_path ?? "");
    if (isArchSignificantPath(path)) return "decision";
    // Unconditional fix-vs-decision distinction needs CI context that
    // the hook doesn't have. Default to decision; substrate clustering
    // re-classifies based on diff content.
    return "decision";
  }

  return null;
}

/**
 * Paths that are architecturally significant — touching them tends to
 * reflect a deliberate decision rather than incidental refactoring.
 * Tunable; substrate's clustering job is the safety net.
 */
function isArchSignificantPath(path: string): boolean {
  const ARCH_RE = /(prisma\/schema\.prisma|next\.config\.|tailwind\.config\.|package\.json|src\/lib\/(auth|db|crypto|sync)|\.github\/workflows\/|CODEOWNERS|CLAUDE\.md|HANDOFF\.md|suraya|patterns\/)/i;
  return ARCH_RE.test(path);
}
